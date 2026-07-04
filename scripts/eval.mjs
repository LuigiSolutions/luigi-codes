#!/usr/bin/env node
// Luigi Codes eval harness (reasoning roadmap, Phase 0 + Phase 1 measurement).
// Measures the local model on two suites:
//   - coding:    executed pass@1 (model writes a JS function, appended tests run under node)
//   - reasoning: multi-step answer accuracy (model ends with "Final answer: X", we compare)
// Strategies (test-time compute, applied to reasoning):
//   - single           one sample per task (default)
//   - self-consistency sample N per task at higher temperature, majority-vote the answer
// Zero runtime deps. Talks to the configured local inference server over HTTP.
// Runs ONLY when a model server is up; with none, prints a clear message and exits.
//
// Usage:
//   npm run eval                                             # both suites, single, defaults
//   npm run eval -- --suite reasoning --difficulty hard      # only the hard reasoning tier
//   npm run eval -- --strategy self-consistency --samples 5  # test-time compute on reasoning
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
const explicitTemp = args.temperature !== undefined;
const CONFIG = {
  endpoint: args.endpoint || process.env.LUIGI_EVAL_ENDPOINT || 'http://localhost:8080',
  provider: args.provider || process.env.LUIGI_EVAL_PROVIDER || 'custom', // custom | lmstudio | ollama
  model: args.model || process.env.LUIGI_EVAL_MODEL || 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
  temperature: explicitTemp ? Number(args.temperature) : 0.2,
  timeoutMs: args.timeout !== undefined ? Number(args.timeout) : 60000,
  suite: args.suite || 'all',            // coding | reasoning | all
  difficulty: args.difficulty || 'all',  // all | base | hard
  strategy: args.strategy || 'single',   // single | self-consistency
  samples: args.samples !== undefined ? Number(args.samples) : 5,
  limit: args.limit !== undefined ? Number(args.limit) : Infinity,
  dryRun: Boolean(args['dry-run']),
  label: args.label || '',
  explicitTemp,
};
// Self-consistency needs diverse samples; default to a warmer temperature unless the
// caller pinned one explicitly.
const SC_TEMPERATURE = explicitTemp ? CONFIG.temperature : 0.8;

function stamp() {
  // Local scripts may use dates freely (unlike workflow scripts).
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// --- model client ------------------------------------------------------------

async function callModel(messages, temperature = CONFIG.temperature) {
  const isOllama = CONFIG.provider === 'ollama';
  const url = isOllama
    ? `${CONFIG.endpoint.replace(/\/$/, '')}/api/chat`
    : `${CONFIG.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const body = isOllama
    ? { model: CONFIG.model, messages, stream: false, options: { temperature } }
    : { model: CONFIG.model, messages, stream: false, temperature };

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
    return stripThinkBlocks(stripStopMarkers(content));
  } finally {
    clearTimeout(timer);
  }
}

// Reasoning-distilled models (DeepSeek-R1 distills, QwQ) emit a long <think>...</think>
// chain before the answer. Score only the post-reasoning text, or the chain's own
// numbers corrupt answer extraction the same way stop markers did. If the closing tag
// is missing (model ran out of tokens mid-thought) leave the text as-is.
function stripThinkBlocks(text) {
  const close = text.lastIndexOf('</think>');
  return close === -1 ? text : text.slice(close + '</think>'.length).trim();
}

// Some raw servers (mlx-lm observed on :8080) leak chat-template stop markers as
// literal text at the end of a reply. The product strips these (streamText.ts,
// splitAtStopMarker, test T23); the harness talks to the server directly, so it
// must strip them too or a correct answer like "wednesday<|im_end|>" scores as wrong.
const STOP_MARKERS = ['<|im_end|>', '<|endoftext|>', '<|eot_id|>', '<|eom_id|>', '<|end|>', '</s>'];
function stripStopMarkers(text) {
  let out = text;
  for (const marker of STOP_MARKERS) {
    const i = out.indexOf(marker);
    if (i !== -1) out = out.slice(0, i);
  }
  return out.trim();
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

// Vote key for self-consistency: numeric tasks collapse to their number, text to normalized.
function answerKey(raw, task) {
  if (task.type === 'number') {
    const nums = String(raw).match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length) return String(Number(nums[nums.length - 1]));
  }
  return normalizeAnswer(raw);
}

function answerMatches(candidate, task) {
  if (task.type === 'number') {
    const expected = Number(task.answer);
    const nums = String(candidate).match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length) {
      const got = Number(nums[nums.length - 1]);
      return Math.abs(got - expected) < 1e-6;
    }
    return false;
  }
  return normalizeAnswer(candidate) === normalizeAnswer(task.answer);
}

const REASONING_SYSTEM = 'Think step by step, then end with a line exactly like "Final answer: X".';

async function scoreReasoningSingle(task) {
  const out = await callModel([
    { role: 'system', content: REASONING_SYSTEM },
    { role: 'user', content: task.prompt },
  ]);
  const raw = extractFinalAnswer(out);
  if (answerMatches(raw, task)) return { ok: true, got: raw };
  // last-resort: expected value appears anywhere in the body
  if (task.type === 'number' && answerMatches(out, task)) return { ok: true, got: `${raw} (found in body)` };
  return { ok: false, got: raw || '(none)' };
}

async function scoreReasoningSelfConsistency(task) {
  const votes = {};      // key -> count
  const rawByKey = {};   // key -> a representative raw answer
  for (let i = 0; i < CONFIG.samples; i++) {
    const out = await callModel([
      { role: 'system', content: REASONING_SYSTEM },
      { role: 'user', content: task.prompt },
    ], SC_TEMPERATURE);
    const raw = extractFinalAnswer(out);
    const key = answerKey(raw, task);
    votes[key] = (votes[key] || 0) + 1;
    if (!(key in rawByKey)) rawByKey[key] = raw;
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [modalKey, modalCount] = ranked[0];
  const ok = answerMatches(rawByKey[modalKey], task) || answerMatches(modalKey, task);
  const tally = ranked.map(([k, c]) => `${k}:${c}`).join(' ');
  return { ok, got: `${rawByKey[modalKey]} (${modalCount}/${CONFIG.samples}; votes ${tally})` };
}

function loadSuite(name) {
  const p = join(TASKS_DIR, `${name}.json`);
  if (!existsSync(p)) throw new Error(`Missing task file: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function selectTasks(suite) {
  let tasks = suite.tasks.map((t) => ({ difficulty: 'base', ...t }));
  if (CONFIG.difficulty !== 'all') tasks = tasks.filter((t) => t.difficulty === CONFIG.difficulty);
  if (Number.isFinite(CONFIG.limit)) tasks = tasks.slice(0, CONFIG.limit);
  return tasks;
}

// --- suites ------------------------------------------------------------------

async function runCoding() {
  const tasks = selectTasks(loadSuite('coding'));
  const results = [];
  for (const t of tasks) {
    process.stdout.write(`  [coding/${t.difficulty}] ${t.id} ... `);
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
    results.push({ id: t.id, difficulty: t.difficulty, passed, detail });
  }
  return { suite: 'coding', strategy: 'single', results };
}

async function runReasoning() {
  const tasks = selectTasks(loadSuite('reasoning'));
  const selfConsistent = CONFIG.strategy === 'self-consistency';
  const results = [];
  for (const t of tasks) {
    process.stdout.write(`  [reasoning/${t.difficulty}] ${t.id} ... `);
    let passed = false, got = '', detail = '';
    try {
      const s = selfConsistent ? await scoreReasoningSelfConsistency(t) : await scoreReasoningSingle(t);
      passed = s.ok; got = s.got;
    } catch (err) {
      detail = (err && err.message) || String(err);
    }
    console.log(passed ? 'PASS' : `FAIL (got: ${got || detail})`);
    results.push({ id: t.id, difficulty: t.difficulty, passed, got, detail });
  }
  return { suite: 'reasoning', strategy: selfConsistent ? `self-consistency x${CONFIG.samples}` : 'single', results };
}

// --- report ------------------------------------------------------------------

function tally(results) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const pct = total ? Math.round((passed / total) * 1000) / 10 : 0;
  return { total, passed, pct };
}

function byDifficulty(results) {
  const groups = {};
  for (const r of results) (groups[r.difficulty] ||= []).push(r);
  const out = {};
  for (const [d, rs] of Object.entries(groups)) out[d] = tally(rs);
  return out;
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
    strategy: CONFIG.strategy,
    samples: CONFIG.strategy === 'self-consistency' ? CONFIG.samples : 1,
    difficulty: CONFIG.difficulty,
    dryRun: CONFIG.dryRun,
  };
  const summaries = {};
  for (const r of runs) summaries[r.suite] = { overall: tally(r.results), byDifficulty: byDifficulty(r.results) };

  const jsonPath = join(REPORTS_DIR, `eval-${when}.json`);
  writeFileSync(jsonPath, JSON.stringify({ meta, summaries, runs }, null, 2));

  const lines = [];
  lines.push(`# Eval report ${when}`);
  lines.push('');
  lines.push(`- model: \`${meta.model}\``);
  lines.push(`- endpoint: ${meta.endpoint} (${meta.provider}), temp ${meta.temperature}${meta.dryRun ? ', dry-run' : ''}`);
  lines.push(`- strategy: ${meta.strategy}${meta.strategy === 'self-consistency' ? ` (${meta.samples} samples)` : ''}, difficulty: ${meta.difficulty}`);
  if (meta.label) lines.push(`- label: ${meta.label}`);
  lines.push('');
  lines.push('| suite | tier | passed | total | score |');
  lines.push('|---|---|---|---|---|');
  for (const r of runs) {
    const s = summaries[r.suite];
    lines.push(`| ${r.suite} (${r.strategy}) | all | ${s.overall.passed} | ${s.overall.total} | ${s.overall.pct}% |`);
    for (const [d, t] of Object.entries(s.byDifficulty)) {
      lines.push(`| | ${d} | ${t.passed} | ${t.total} | ${t.pct}% |`);
    }
  }
  lines.push('');
  for (const r of runs) {
    lines.push(`## ${r.suite} (${r.strategy})`);
    for (const item of r.results) {
      const mark = item.passed ? 'PASS' : 'FAIL';
      const extra = item.passed ? '' : ` (${item.got || item.detail || ''})`;
      lines.push(`- ${mark} [${item.difficulty}] ${item.id}${extra}`);
    }
    lines.push('');
  }
  const mdPath = join(REPORTS_DIR, `eval-${when}.md`);
  writeFileSync(mdPath, lines.join('\n'));
  return { jsonPath, mdPath, summaries };
}

// --- self-test (no model server needed) --------------------------------------

function runSelftest() {
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);

  // Regression: stop-marker stripping (the scorer bug that masked correct answers).
  check('strip im_end', stripStopMarkers('wednesday<|im_end|>') === 'wednesday');
  check('strip endoftext + trailing junk', stripStopMarkers('42<|endoftext|>\nnoise') === '42');
  check('no marker untouched', stripStopMarkers('hello world') === 'hello world');

  // Regression: <think> stripping for reasoning-distilled models (R1 / QwQ).
  check('strip think block', stripThinkBlocks('<think>1+1=3? no, 2</think>Final answer: 2') === 'Final answer: 2');
  check('no think tag untouched', stripThinkBlocks('Final answer: 5') === 'Final answer: 5');
  check('unclosed think left as-is', stripThinkBlocks('<think>still reasoning') === '<think>still reasoning');

  // Answer matching across formats.
  check('number exact', answerMatches('Final answer: 7', { type: 'number', answer: '7' }));
  check('number decimal', answerMatches('7.5 degrees', { type: 'number', answer: '7.5' }));
  check('number rejects wrong', !answerMatches('8', { type: 'number', answer: '7' }));
  check('text fraction latex folds', answerMatches('\\(\\frac{1}{6}\\)', { type: 'text', answer: '1/6' }));
  check('text word', answerMatches('Wednesday', { type: 'text', answer: 'wednesday' }));

  // Vote keys collapse equivalent answers so self-consistency tallies correctly.
  check('vote key number', answerKey('the answer is 1/6', { type: 'number', answer: '0' }) === '6');
  check('vote key text frac', answerKey('\\frac{1}{6}', { type: 'text', answer: '1/6' }) === '1/6');

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }
  console.log(`\nself-test: ${checks.length - failed}/${checks.length} passed`);
  return failed === 0;
}

// --- main --------------------------------------------------------------------

async function main() {
  if (args.selftest) { process.exit(runSelftest() ? 0 : 1); }
  console.log('Luigi Codes eval harness');
  console.log(`  model=${CONFIG.model} endpoint=${CONFIG.endpoint} provider=${CONFIG.provider}`);
  console.log(`  strategy=${CONFIG.strategy}${CONFIG.strategy === 'self-consistency' ? ` samples=${CONFIG.samples} sc-temp=${SC_TEMPERATURE}` : ` temp=${CONFIG.temperature}`} difficulty=${CONFIG.difficulty}`);
  await assertServerReachable();

  const runs = [];
  if (CONFIG.suite === 'coding' || CONFIG.suite === 'all') runs.push(await runCoding());
  if (CONFIG.suite === 'reasoning' || CONFIG.suite === 'all') runs.push(await runReasoning());

  const { jsonPath, mdPath, summaries } = writeReport(runs);
  console.log('\nSummary:');
  for (const r of runs) {
    const s = summaries[r.suite];
    const tiers = Object.entries(s.byDifficulty).map(([d, t]) => `${d} ${t.passed}/${t.total}`).join(', ');
    console.log(`  ${r.suite.padEnd(10)} (${r.strategy}) ${s.overall.passed}/${s.overall.total} (${s.overall.pct}%)  [${tiers}]`);
  }
  console.log(`\nReport written:\n  ${mdPath}\n  ${jsonPath}`);
}

main().catch((err) => {
  console.error('\nEval failed:', (err && err.message) || err);
  process.exit(1);
});
