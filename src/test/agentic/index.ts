/**
 * Agentic eval runner (Phase 0.4), loaded inside the extension host by
 * @vscode/test-electron. Runs the REAL 5-phase agent loop against a scratch
 * workspace and scores by end state (a node check that throws on failure).
 *
 * Design: docs/AGENTIC_EVAL_DESIGN.md. Product code is untouched; the human
 * approval modal is auto-answered here by monkeypatching vscode.window
 * .showWarningMessage for the duration of the sandbox eval only.
 *
 * Needs a model server (env LUIGI_AGENTIC_ENDPOINT, default http://localhost:8082).
 * Env knobs: LUIGI_AGENTIC_MODEL, LUIGI_AGENTIC_N (runs/task, default 3),
 * LUIGI_AGENTIC_LIMIT (max tasks), LUIGI_AGENTIC_TASKS (tasks.json path),
 * LUIGI_AGENTIC_WS (scratch workspace root).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import { LuigiAgent } from '../../agent/agentLoop';
import { createDefaultTools, ToolRegistry } from '../../agent/tools/toolRegistry';
import { CodebaseIndex } from '../../context/codebaseIndex';
import { MemorySystem } from '../../memory/memorySystem';
import { ModelRouter } from '../../inference/modelRouter';
import { SelfImprovement } from '../../improvement/selfImprove';

interface AgTask {
  id: string;
  difficulty: string;
  prompt: string;
  setup: { path: string; content: string }[];
  check: string;
}

const noop = (): void => undefined;

function resetWorkspace(root: string): void {
  for (const name of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function applySetup(root: string, setup: AgTask['setup']): void {
  for (const f of setup) {
    const full = path.join(root, f.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, f.content, 'utf8');
  }
}

/** Run the task's end-state check in a fresh node process; exit 0 = pass. */
function runCheck(root: string, code: string): { ok: boolean; detail: string } {
  const file = path.join(root, '__agentic_check.js');
  fs.writeFileSync(file, code + '\n', 'utf8');
  try {
    const res = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', timeout: 15_000 });
    const ok = res.status === 0 && !res.error;
    let detail = '';
    if (res.error) {
      detail = (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'check timed out' : res.error.message;
    } else if (res.status !== 0) {
      // Surface the real error line (the "Error: ..." throw), not node's version footer.
      const lines = (res.stderr || '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
      detail = lines.find((l) => /^[A-Za-z]*Error:/.test(l)) || lines[lines.length - 1] || 'check failed';
    }
    return { ok, detail };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function run(): Promise<void> {
  const endpoint = process.env.LUIGI_AGENTIC_ENDPOINT || 'http://localhost:8082';
  const model = process.env.LUIGI_AGENTIC_MODEL || 'luigi-base';
  const N = Number(process.env.LUIGI_AGENTIC_N || '3');
  const limit = process.env.LUIGI_AGENTIC_LIMIT ? Number(process.env.LUIGI_AGENTIC_LIMIT) : Infinity;
  const tasksPath = process.env.LUIGI_AGENTIC_TASKS || path.resolve(__dirname, '../../../eval/agentic/tasks.json');
  const ws = process.env.LUIGI_AGENTIC_WS || (vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? process.cwd());

  // Point the router at the served model.
  const cfg = vscode.workspace.getConfiguration('luigi');
  await cfg.update('model.provider', 'custom', vscode.ConfigurationTarget.Global);
  await cfg.update('model.endpoint', endpoint, vscode.ConfigurationTarget.Global);
  await cfg.update('model.primaryModel', model, vscode.ConfigurationTarget.Global);

  // Auto-approve inside the sandbox ONLY (product code untouched).
  (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
    async () => 'Approve & Run';

  const router = new ModelRouter(noop);
  const tools = new ToolRegistry(noop);
  for (const tool of createDefaultTools(noop)) tools.register(tool);
  const storage = vscode.Uri.file(fs.mkdtempSync(path.join(require('os').tmpdir(), 'luigi-ag-store-')));
  const index = new CodebaseIndex(router, noop);
  const memory = new MemorySystem(storage, router, noop);
  const improve = new SelfImprovement(storage, noop);
  const agent = new LuigiAgent(router, tools, index, memory, improve, noop);

  const all: AgTask[] = JSON.parse(fs.readFileSync(tasksPath, 'utf8')).tasks;
  const tasks = all.slice(0, limit);
  const results: { id: string; difficulty: string; passes: number; runs: number; passed: boolean; flaky: boolean; details: string[] }[] = [];

  console.log(`\nAgentic eval: ${tasks.length} tasks x ${N} run(s), model=${model} endpoint=${endpoint}`);
  for (const t of tasks) {
    const details: string[] = [];
    let passes = 0;
    for (let i = 0; i < N; i++) {
      resetWorkspace(ws);
      applySetup(ws, t.setup);
      let detail = '';
      try {
        const res = await agent.execute({ prompt: t.prompt });
        const chk = runCheck(ws, t.check);
        if (chk.ok) passes++;
        const tools = res.outcomes.map((o) => `${o.step.tool || '?'}:${o.ok ? 'ok' : 'x'}`).join(',');
        detail = chk.ok
          ? 'PASS'
          : `FAIL(check: ${chk.detail || 'failed'}; agent success=${res.success}; steps=${res.outcomes.length}[${tools}]; summary="${(res.summary || '').slice(0, 160)}")`;
      } catch (err) {
        detail = `ERROR(${(err as Error)?.message || String(err)})`;
      }
      details.push(detail);
    }
    resetWorkspace(ws);
    const passed = passes >= Math.ceil(N / 2) && passes === N; // stable pass = all N (strict); flaky flagged below
    const stablePass = passes >= Math.ceil((2 * N) / 3);
    const flaky = passes > 0 && passes < N;
    results.push({ id: t.id, difficulty: t.difficulty, passes, runs: N, passed: stablePass, flaky, details });
    console.log(`  [agentic/${t.difficulty}] ${t.id} ... ${passes}/${N} ${stablePass ? 'PASS' : 'FAIL'}${flaky ? ' (FLAKY)' : ''}`);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const flakyCount = results.filter((r) => r.flaky).length;
  console.log(`\nAgentic summary: ${passedCount}/${tasks.length} stable-pass (>=2/3 of ${N}), ${flakyCount} flaky`);

  // Write a report next to the other eval reports.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportsDir = path.resolve(__dirname, '../../../eval/reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const out = { meta: { when: stamp, kind: 'agentic', model, endpoint, N, tasks: tasks.length }, summary: { passed: passedCount, flaky: flakyCount, total: tasks.length }, results };
  fs.writeFileSync(path.join(reportsDir, `agentic-${stamp}.json`), JSON.stringify(out, null, 2));
  console.log(`Report: eval/reports/agentic-${stamp}.json`);
}
