#!/usr/bin/env node
// Contamination check (reasoning roadmap, Phase 2 data hygiene).
// A distillation dataset must not contain any problem that also appears in the eval
// task set, or the eval stops measuring generalization and starts measuring memorization.
// This compares every training prompt against every eval task prompt three ways:
//   1. exact match on the normalized core problem (instruction boilerplate stripped),
//   2. substring containment either direction,
//   3. word-level Jaccard similarity, reporting the closest train prompt per eval task.
// Exits non-zero if any exact/substring collision is found, or any pair is at/above the
// --threshold Jaccard (default 0.7). Prints the closest pairs regardless, for eyeballing.
//
// Usage:
//   npm run check:contamination
//   node scripts/check-contamination.mjs --train training/dataset/train.jsonl --threshold 0.7

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

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
  trainFiles: (args.train ? [args.train] : ['training/dataset/train.jsonl', 'training/dataset/valid.jsonl']).map(abs),
  tasksDir: abs('eval/tasks'),
  threshold: args.threshold !== undefined ? Number(args.threshold) : 0.7,
  show: args.show !== undefined ? Number(args.show) : 5,
};

// Strip instruction boilerplate that is shared across all eval prompts (and would inflate
// similarity), then normalize to lowercase alphanumeric words.
function stripInstructions(s) {
  return String(s)
    .replace(/end with a line[^.]*\.?/gi, ' ')
    .replace(/give (the answer|a decimal|a fraction)[^.]*\.?/gi, ' ')
    .replace(/answer with[^.]*\.?/gi, ' ')
    .replace(/return only the function[^.]*\.?/gi, ' ')
    .replace(/final answer\s*[:\-]?\s*x?/gi, ' ');
}
const words = (s) => stripInstructions(s).toLowerCase().match(/[a-z0-9]+/g) || [];
const core = (s) => words(s).join(' ');

function jaccard(aWords, bWords) {
  const A = new Set(aWords), B = new Set(bWords);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function loadEvalPrompts() {
  const out = [];
  for (const name of ['reasoning.json', 'coding.json']) {
    const p = join(CONFIG.tasksDir, name);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    for (const t of j.tasks) out.push({ id: t.id, suite: j.suite, prompt: t.prompt });
  }
  return out;
}

function loadTrainPrompts() {
  const out = [];
  for (const f of CONFIG.trainFiles) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const l = line.trim();
      if (!l) continue;
      const row = JSON.parse(l);
      const user = row.messages?.find((m) => m.role === 'user');
      if (user?.content) out.push({ prompt: user.content });
    }
  }
  return out;
}

function main() {
  const evalTasks = loadEvalPrompts().map((t) => ({ ...t, words: words(t.prompt), core: core(t.prompt) }));
  const train = loadTrainPrompts().map((t) => ({ ...t, words: words(t.prompt), core: core(t.prompt) }));
  if (!train.length) { console.error('No training prompts found. Build the dataset first (npm run filter:traces).'); process.exit(2); }

  console.log(`check-contamination: ${evalTasks.length} eval tasks vs ${train.length} train prompts (threshold ${CONFIG.threshold})`);

  const trainCoreSet = new Set(train.map((t) => t.core));
  const collisions = [];
  const closest = [];

  for (const e of evalTasks) {
    // 1. exact core match
    if (trainCoreSet.has(e.core)) collisions.push({ kind: 'exact', id: e.id });
    // 2. substring containment (either direction), guard against trivial short cores
    if (e.core.length > 25) {
      for (const t of train) {
        if (t.core.includes(e.core) || e.core.includes(t.core)) { collisions.push({ kind: 'substring', id: e.id, train: t.prompt.slice(0, 90) }); break; }
      }
    }
    // 3. best Jaccard
    let best = { j: -1, prompt: '' };
    for (const t of train) {
      const j = jaccard(e.words, t.words);
      if (j > best.j) best = { j, prompt: t.prompt };
    }
    closest.push({ id: e.id, suite: e.suite, j: best.j, prompt: best.prompt });
  }

  closest.sort((a, b) => b.j - a.j);
  console.log(`\nTop ${CONFIG.show} most-similar eval/train pairs (by word Jaccard):`);
  for (const c of closest.slice(0, CONFIG.show)) {
    console.log(`  J=${c.j.toFixed(3)}  ${c.id}`);
    console.log(`     nearest train: ${c.prompt.slice(0, 110).replace(/\n/g, ' ')}...`);
  }

  const overThreshold = closest.filter((c) => c.j >= CONFIG.threshold);
  console.log('');
  if (collisions.length) {
    console.log(`FAIL: ${collisions.length} exact/substring collision(s):`);
    for (const c of collisions) console.log(`  ${c.kind}: ${c.id}${c.train ? ' ~ ' + c.train : ''}`);
  }
  if (overThreshold.length) {
    console.log(`FAIL: ${overThreshold.length} pair(s) at/above Jaccard ${CONFIG.threshold}:`);
    for (const c of overThreshold) console.log(`  J=${c.j.toFixed(3)} ${c.id}`);
  }
  if (!collisions.length && !overThreshold.length) {
    console.log(`CLEAN: no exact match, no substring containment, max Jaccard ${closest[0]?.j.toFixed(3)} < ${CONFIG.threshold}.`);
    process.exit(0);
  }
  process.exit(1);
}

main();
