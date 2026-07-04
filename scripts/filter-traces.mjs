#!/usr/bin/env node
// Rejection-sample teacher traces into a clean distillation dataset (Phase 2 data prep).
// This is the "remove hallucinated or messy chains" layer: it keeps only traces whose
// answer is verifiably correct and whose chain is well-formed, then writes chat-format
// train/valid JSONL that TRAINING.md's mlx LoRA (or a RunPod SFT) consumes directly.
//
// It reuses the SAME verifier the eval harness uses (scripts/lib/verify.mjs), so a
// trace is judged by the exact rules that score a model - a wrong teacher chain can
// never leak into training.
//
// Gates: structural (non-empty, not truncated mid-<think>), correctness (code passes
// its tests / reasoning answer matches ground truth), quality (length bounds, no
// degenerate repetition), and dedup (by prompt).
//
// Usage:
//   npm run filter:traces -- --in training/traces/raw-<stamp>.jsonl
//   npm run filter:traces -- --in <path> --out training/dataset --strip-think-tags
//   npm run filter:traces -- --in <path> --min-chars 40 --max-chars 16000

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';
import { stripStopMarkers, stripThinkBlocks, extractCode, extractFinalAnswer, answerMatches, runJs } from './lib/verify.mjs';

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
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

function latestTraceFile() {
  const dir = join(ROOT, 'training', 'traces');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith('raw-') && f.endsWith('.jsonl')).sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

const CONFIG = {
  in: args.in ? abs(args.in) : latestTraceFile(),
  out: abs(args.out || 'training/dataset'),
  minChars: args['min-chars'] !== undefined ? Number(args['min-chars']) : 20,
  maxChars: args['max-chars'] !== undefined ? Number(args['max-chars']) : 20000,
  stripThinkTags: Boolean(args['strip-think-tags']),
  validEvery: args['valid-every'] !== undefined ? Number(args['valid-every']) : 10, // 1-in-N to valid
};

// A chain is degenerate if a substantial line repeats many times (looping models).
function isRepetitive(text) {
  const counts = {};
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l.length < 20) continue;
    counts[l] = (counts[l] || 0) + 1;
    if (counts[l] >= 4) return true;
  }
  return false;
}

function verdict(trace) {
  const output = String(trace.output || '');
  if (!output.trim()) return { keep: false, reason: 'empty' };
  // Truncated mid-thought: opened a <think> but never closed it.
  if (output.includes('<think>') && !output.includes('</think>')) return { keep: false, reason: 'truncated' };

  const clean = stripThinkBlocks(stripStopMarkers(output));
  if (trace.kind === 'coding') {
    if (!trace.tests) return { keep: false, reason: 'no-tests' };
    const r = runJs(extractCode(clean), trace.tests);
    if (!r.ok) return { keep: false, reason: 'wrong-code' };
  } else {
    const got = extractFinalAnswer(clean);
    if (!got) return { keep: false, reason: 'no-answer' };
    if (!answerMatches(got, { type: trace.type, answer: trace.answer })) return { keep: false, reason: 'wrong-answer' };
  }

  const target = stripStopMarkers(output);
  if (target.length < CONFIG.minChars) return { keep: false, reason: 'too-short' };
  if (target.length > CONFIG.maxChars) return { keep: false, reason: 'too-long' };
  if (isRepetitive(target)) return { keep: false, reason: 'repetitive' };
  return { keep: true, reason: 'ok' };
}

function toExample(trace) {
  let assistant = stripStopMarkers(String(trace.output));
  if (CONFIG.stripThinkTags) assistant = assistant.replace(/<\/?think>/g, '').trim();
  return { messages: [{ role: 'user', content: trace.prompt }, { role: 'assistant', content: assistant }] };
}

function main() {
  if (!CONFIG.in || !existsSync(CONFIG.in)) {
    console.error('No trace file. Generate first: npm run gen:traces, or pass --in <path>.');
    process.exit(2);
  }
  const traces = readFileSync(CONFIG.in, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
  const stats = {};
  const seen = new Set();
  const accepted = [];
  for (const t of traces) {
    const key = String(t.prompt).trim();
    if (seen.has(key)) { stats.dup = (stats.dup || 0) + 1; continue; }
    seen.add(key);
    const v = verdict(t);
    stats[v.reason] = (stats[v.reason] || 0) + 1;
    if (v.keep) accepted.push(t);
  }

  if (!existsSync(CONFIG.out)) mkdirSync(CONFIG.out, { recursive: true });
  const train = [], valid = [];
  accepted.forEach((t, i) => (i % CONFIG.validEvery === 0 ? valid : train).push(toExample(t)));
  const write = (name, rows) => writeFileSync(join(CONFIG.out, name), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  write('train.jsonl', train);
  write('valid.jsonl', valid);

  console.log(`filter-traces: ${traces.length} traces in, ${accepted.length} accepted`);
  console.log('  breakdown:', Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`  wrote ${train.length} train + ${valid.length} valid to ${CONFIG.out.replace(ROOT + '/', '')}/`);
  console.log('  train on it per TRAINING.md (mlx LoRA) or the RunPod SFT step.');
}

main();
