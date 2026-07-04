#!/usr/bin/env node
// Luigi Codes eval harness (Phase 0 of the reasoning roadmap).
// Measures the local model on two suites:
//   - coding:    executed pass@1 (model writes a JS function, appended tests run under node)
//   - reasoning: multi-step answer accuracy (model ends with "Final answer: X", we compare)
// Zero runtime deps. Talks to the configured local inference server over HTTP.
// It runs ONLY when a model server is up; with none, it prints a clear message and exits.
//
// Usage:
//   npm run eval                       # both suites, defaults below
//   npm run eval -- --suite reasoning  # one suite
//   npm run eval -- --endpoint http://localhost:11434 --provider ollama --model qwen2.5-coder:7b
//   npm run eval -- --limit 3          # first 3 tasks per suite (quick smoke)
//   npm run eval -- --dry-run          # generate, do not execute coding tasks
//
// Note: coding tasks execute model-generated JavaScript in a subprocess (temp dir,
// hard timeout). That is standard for code benchmarks; use --dry-run to skip execution.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TASKS_DIR = join(ROOT, 'eval', 'tasks');
const REPORTS_DIR = join(ROOT, 'eval', 'reports');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  endpoint: args.endpoint || process.env.LUIGI_EVAL_ENDPOINT || 'http://localhost:8080',
  provider: args.provider || process.env.LUIGI_EVAL_PROVIDER || 'custom', // custom | lmstudio | ollama
  model: args.model || process.env.LUIGI_EVAL_MODEL || 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
  temperature: args.temperature !== undefined ? Number(args.temperature) : 0.2,
  timeoutMs: args.timeout !== undefined ? Number(args.timeout) : 60000,
  suite: args.suite || 'all',      // coding | reasoning | all
  limit: args.limit !== undefined ? Number(args.limit) : Infinity,
  dryRun: Boolean(args['dry-run']),
  label: args.label || '',
};

function stamp() {
  // Local scripts may use dates freely (unlike workflow scripts).
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// --- model client ------------------------------------------------------------

async function callModel(messages) {
  const isOllama = CONFIG.provider === 'ollama';
  const url = isOllama
    ? `${CONFIG.endpoint.replace(/\/$/, '')}/api/chat`
    : `${CONFIG.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const body = isOllama
    ? { model: CONFIG.model, messages, stream: false, options: { temperature: CONFIG.temperature } }
    : { model: CONFIG.model, messages, stream: false, temperature: CONFIG.temperature };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ': ' + text.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    const content = isOllama
      ? data?.message?.content
      : data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Model response had no message content.');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function assertServerReachable() {
  try {
    await callModel([{ role: 'user', content: 'Reply with the single word: ok' }]);
  } catch (err) {
    const msg = err && err.name === 'AbortError'
      ? `timed out after ${CONFIG.timeoutMs}ms`
      : (err && err.message) || String(err);
    console.error('\nNo model server reachable for evaluation.');
    console.error(`  endpoint : ${CONFIG.endpoint}`);
    console.error(`  provider : ${CONFIG.provider}`);
    console.error(`  model    : ${CONFIG.model}`);
    console.error(`  reason   : ${msg}`);
    console.error('\nStart your local server, then re-run. For the fine-tuned mlx model:');
    console.error('  ~/.luigi-mlx/bin/python scripts/serve-model.py \\');
    console.error('    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \\');
    console.error('    --adapter-path ~/luigi-finetune/luigi-adapter --port 8080');
    console.error('Or point at another server: npm run eval -- --endpoint http://localhost:11434 --provider ollama --model qwen2.5-coder:7b\n');
    process.exit(2);
  }
}

// --- helpers -----------------------------------------------------------------

function extractCode(text) {
  // Prefer the longest fenced block; fall back to the raw text.
  const blocks = [...text.matchAll(/```(?:[a-zA-Z0-9]*)\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].trim();
  return text.trim();
}

function runJs(code, tests) {
  const file = join(tmpdir(), `luigi-eval-${process.pid}-${Math.floor(performance.now())}.mjs`);
  writeFileSync(file, `${code}\n\n${tests}\n`);
  const res = spawnSync(process.execPath, [file], {
    timeout: 10000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ok = res.status === 0 && !res.error;
  const detail = res.error
    ? (res.error.code === 'ETIMEDOUT' ? 'execution timed out' : res.error.message)
    : (res.status === 0 ? '' : (res.stderr || '').trim().split('\n').slice(-1)[0]);
  return { ok, detail };
}

function canonicalizeMath(s) {
  // Fold common LaTeX / markdown answer formatting so 3/10 == \frac{3}{10} == \(3/10\).
  return String(s)
    .replace(/\\frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(-?\d+)\s*\}/g, '$1/$2')
    .replace(/\\[a-z()[\]]+/gi, '')   // stray LaTeX commands / delimiters
    .replace(/[\\${}()[\]]/g, '');
}

function normalizeAnswer(s) {
  return canonicalizeMath(s).toLowerCase().replace(/[\s,]/g, '').replace(/[.]$/, '').trim();
}

function extractFinalAnswer(text) {
  const m = [...text.matchAll(/final answer\s*[:\-]?\s*([^\n]+)/gi)];
  if (m.length) return m[m.length - 1][1].trim();
  // fallback: last non-empty line
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function scoreReasoning(output, task) {
  const raw = extractFinalAnswer(output);
  if (task.type === 'number') {
    const expected = Number(task.answer);
    const nums = raw.match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length) {
      const got = Number(nums[nums.length - 1]);
      if (Math.abs(got - expected) < 1e-6) return { ok: true, got: String(got) };
    }
    // last-resort: scan the whole output for the expected value as a token
    const all = output.match(/-?\d+(?:\.\d+)?/g) || [];
    if (all.some((n) => Math.abs(Number(n) - expected) < 1e-6)) return { ok: true, got: `${raw} (found in body)` };
    return { ok: false, got: raw || '(none)' };
  }
  const ok = normalizeAnswer(raw) === normalizeAnswer(task.answer)
    || normalizeAnswer(output).includes(normalizeAnswer(task.answer));
  return { ok, got: raw || '(none)' };
}

function loadSuite(name) {
  const p = join(TASKS_DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`Missing task file: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function limited(tasks) {
  return Number.isFinite(CONFIG.limit) ? tasks.slice(0, CONFIG.limit) : tasks;
}

// --- suites ------------------------------------------------------------------

async function runCoding() {
  const suite = loadSuite('coding');
  const tasks = limited(suite.tasks);
  const results = [];
  for (const t of tasks) {
    process.stdout.write(`  [coding] ${t.id} ... `);
    let passed = false, detail = '';
    try {
      const out = await callModel([
        { role: 'system', content: 'You are a precise JavaScript engineer. Return only code, no prose.' },
        { role: 'user', content: t.prompt },
      ]);
      const code = extractCode(out);
      if (CONFIG.dryRun) { detail = 'dry-run (not executed)'; }
      else { const r = runJs(code, t.tests); passed = r.ok; detail = r.detail; }
    } catch (err) {
      detail = (err && err.message) || String(err);
    }
    console.log(passed ? 'PASS' : (CONFIG.dryRun ? 'GEN' : `FAIL${detail ? ' (' + detail + ')' : ''}`));
    results.push({ id: t.id, passed, detail });
  }
  return { suite: 'coding', results };
}

async function runReasoning() {
  const suite = loadSuite('reasoning');
  const tasks = limited(suite.tasks);
  const results = [];
  for (const t of tasks) {
    process.stdout.write(`  [reasoning] ${t.id} ... `);
    let passed = false, got = '', detail = '';
    try {
      const out = await callModel([
        { role: 'system', content: 'Think step by step, then end with a line exactly like "Final answer: X".' },
        { role: 'user', content: t.prompt },
      ]);
      const s = scoreReasoning(out, t);
      passed = s.ok; got = s.got;
    } catch (err) {
      detail = (err && err.message) || String(err);
    }
    console.log(passed ? 'PASS' : `FAIL (got: ${got || detail})`);
    results.push({ id: t.id, passed, got, detail });
  }
  return { suite: 'reasoning', results };
}

// --- report ------------------------------------------------------------------

function summarize(suiteResult) {
  const total = suiteResult.results.length;
  const passed = suiteResult.results.filter((r) => r.passed).length;
  const pct = total ? Math.round((passed / total) * 1000) / 10 : 0;
  return { total, passed, pct };
}

function writeReport(runs) {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const when = stamp();
  const meta = {
    when,
    label: CONFIG.label || null,
    endpoint: CONFIG.endpoint,
    provider: CONFIG.provider,
    model: CONFIG.model,
    temperature: CONFIG.temperature,
    dryRun: CONFIG.dryRun,
  };
  const summaries = {};
  for (const r of runs) summaries[r.suite] = summarize(r);

  const jsonPath = join(REPORTS_DIR, `eval-${when}.json`);
  writeFileSync(jsonPath, JSON.stringify({ meta, summaries, runs }, null, 2));

  const lines = [];
  lines.push(`# Eval report ${when}`);
  lines.push('');
  lines.push(`- model: \`${meta.model}\``);
  lines.push(`- endpoint: ${meta.endpoint} (${meta.provider}), temp ${meta.temperature}${meta.dryRun ? ', dry-run' : ''}`);
  if (meta.label) lines.push(`- label: ${meta.label}`);
  lines.push('');
  lines.push('| suite | passed | total | score |');
  lines.push('|---|---|---|---|');
  for (const r of runs) {
    const s = summaries[r.suite];
    lines.push(`| ${r.suite} | ${s.passed} | ${s.total} | ${s.pct}% |`);
  }
  lines.push('');
  for (const r of runs) {
    lines.push(`## ${r.suite}`);
    for (const item of r.results) {
      const mark = item.passed ? 'PASS' : 'FAIL';
      const extra = item.passed ? '' : ` (${item.got || item.detail || ''})`;
      lines.push(`- ${mark} ${item.id}${extra}`);
    }
    lines.push('');
  }
  const mdPath = join(REPORTS_DIR, `eval-${when}.md`);
  writeFileSync(mdPath, lines.join('\n'));
  return { jsonPath, mdPath, summaries };
}

// --- main --------------------------------------------------------------------

async function main() {
  console.log('Luigi Codes eval harness');
  console.log(`  model=${CONFIG.model} endpoint=${CONFIG.endpoint} provider=${CONFIG.provider} temp=${CONFIG.temperature}`);
  await assertServerReachable();

  const runs = [];
  if (CONFIG.suite === 'coding' || CONFIG.suite === 'all') runs.push(await runCoding());
  if (CONFIG.suite === 'reasoning' || CONFIG.suite === 'all') runs.push(await runReasoning());

  const { jsonPath, mdPath, summaries } = writeReport(runs);
  console.log('\nSummary:');
  for (const r of runs) {
    const s = summaries[r.suite];
    console.log(`  ${r.suite.padEnd(10)} ${s.passed}/${s.total}  (${s.pct}%)`);
  }
  console.log(`\nReport written:\n  ${mdPath}\n  ${jsonPath}`);
}

main().catch((err) => {
  console.error('\nEval failed:', (err && err.message) || err);
  process.exit(1);
});
