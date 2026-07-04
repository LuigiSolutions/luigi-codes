#!/usr/bin/env node
// Generate teacher traces for distillation (reasoning roadmap, Phase 2 data prep).
// Reads a prompt set (JSONL, disjoint from the eval set) and asks a teacher model
// for a full step-by-step answer, keeping the reasoning chain (that is what we
// distill). Raw traces are written to training/traces/; the filter judges them next.
//
// The teacher is whatever server you point at. For the proof phase, R1 traces come
// from free open datasets; use this to generate fresh Luigi-specific traces from a
// strong reasoner (full DeepSeek-R1 via its API, or a self-hosted R1).
//
// Usage:
//   npm run gen:traces -- --model mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit
//   npm run gen:traces -- --endpoint http://localhost:8080 --provider custom --in training/prompts/seed.jsonl
//
// Unlike the eval client, this keeps <think> blocks (strips only stop markers), so
// the reasoning survives into the training target.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { stripStopMarkers } from './lib/verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  endpoint: args.endpoint || process.env.LUIGI_EVAL_ENDPOINT || 'http://localhost:8080',
  provider: args.provider || process.env.LUIGI_EVAL_PROVIDER || 'custom',
  model: args.model || process.env.LUIGI_EVAL_MODEL || 'mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit',
  temperature: args.temperature !== undefined ? Number(args.temperature) : 0.3,
  maxTokens: args['max-tokens'] !== undefined ? Number(args['max-tokens']) : 4096,
  timeoutMs: args.timeout !== undefined ? Number(args.timeout) : 300000,
  in: args.in || join(ROOT, 'training', 'prompts', 'seed.jsonl'),
  limit: args.limit !== undefined ? Number(args.limit) : Infinity,
};

const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function callTeacher(messages) {
  const isOllama = CONFIG.provider === 'ollama';
  const url = isOllama
    ? `${CONFIG.endpoint.replace(/\/$/, '')}/api/chat`
    : `${CONFIG.endpoint.replace(/\/$/, '')}/v1/chat/completions`;
  const body = isOllama
    ? { model: CONFIG.model, messages, stream: false, options: { temperature: CONFIG.temperature, num_predict: CONFIG.maxTokens } }
    : { model: CONFIG.model, messages, stream: false, temperature: CONFIG.temperature, max_tokens: CONFIG.maxTokens };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    const content = isOllama ? data?.message?.content : data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return stripStopMarkers(content); // keep <think>; drop only stop markers
  } finally {
    clearTimeout(timer);
  }
}

const REASONING_SYSTEM = 'Think step by step, then end with a line exactly like "Final answer: X".';
const CODING_SYSTEM = 'You are a precise JavaScript engineer. Think about edge cases, then return the function.';

async function main() {
  const inPath = abs(CONFIG.in);
  if (!existsSync(inPath)) { console.error(`Missing prompt file: ${inPath}`); process.exit(2); }
  const prompts = readFileSync(inPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => JSON.parse(l));
  const selected = Number.isFinite(CONFIG.limit) ? prompts.slice(0, CONFIG.limit) : prompts;

  const outDir = join(ROOT, 'training', 'traces');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `raw-${stamp()}.jsonl`);

  console.log(`gen-traces: teacher=${CONFIG.model} endpoint=${CONFIG.endpoint} prompts=${selected.length}`);
  const lines = [];
  for (const p of selected) {
    process.stdout.write(`  ${p.id} ... `);
    let output = null, err = '';
    try {
      output = await callTeacher([
        { role: 'system', content: p.kind === 'coding' ? CODING_SYSTEM : REASONING_SYSTEM },
        { role: 'user', content: p.prompt },
      ]);
    } catch (e) { err = (e && e.message) || String(e); }
    if (output) { console.log(`ok (${output.length} chars)`); }
    else { console.log(`no output${err ? ' (' + err + ')' : ''}`); }
    lines.push(JSON.stringify({ ...p, teacher: CONFIG.model, output: output || '', error: err || undefined }));
  }
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`\nWrote ${lines.length} raw traces:\n  ${outPath}\nNext: npm run filter:traces -- --in ${outPath.replace(ROOT + '/', '')}`);
}

main().catch((e) => { console.error('gen-traces failed:', (e && e.message) || e); process.exit(1); });
