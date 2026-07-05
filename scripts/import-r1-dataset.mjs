#!/usr/bin/env node
// Import R1 teacher traces from an open HuggingFace dataset (reasoning roadmap, Phase 2 data prep).
// The teacher rule: DeepSeek-R1 / QwQ / open R1 datasets ONLY (never a closed model).
// This pulls real DeepSeek-R1 reasoning chains from an open dataset over plain HTTP
// (the datasets-server rows API, JSON, zero deps) and writes them as raw traces in the
// exact format scripts/gen-traces.mjs produces, so the SAME filter (scripts/filter-traces.mjs)
// then does the honest rejection sampling against our shared verifier.
//
// Only rows whose ground-truth answer is a clean number or simple fraction are kept
// (that is our verifier's competence zone); messy multi-value answers are skipped. For
// each kept row we take the first generation the source flags correct, extract R1's OWN
// boxed answer, and append a "Final answer: X" line using THAT value (not ground truth),
// so filter-traces still independently verifies R1 against the ground truth and rejects
// any chain whose boxed answer is wrong or unextractable. Rejection sampling stays real.
//
// Usage:
//   npm run import:r1                                  # defaults: open-r1/OpenR1-Math-220k, target 900
//   node scripts/import-r1-dataset.mjs --target 900 --max-rows 4000 --max-chars 14000
//
// Default teacher dataset: open-r1/OpenR1-Math-220k (DeepSeek-R1 traces, MIT, from the
// HuggingFace open-r1 project). See docs/REASONING_ROADMAP.md.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  dataset: args.dataset || 'open-r1/OpenR1-Math-220k',
  config: args.config || 'default',
  split: args.split || 'train',
  target: args.target !== undefined ? Number(args.target) : 900,   // candidate traces to emit
  maxRows: args['max-rows'] !== undefined ? Number(args['max-rows']) : 6000, // scan cap
  maxChars: args['max-chars'] !== undefined ? Number(args['max-chars']) : 14000, // fit the training window
  minChars: args['min-chars'] !== undefined ? Number(args['min-chars']) : 200,
  pageSize: args['page-size'] !== undefined ? Number(args['page-size']) : 100,
};

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const teacherLabel = `deepseek-ai/DeepSeek-R1 (${CONFIG.dataset})`;

// Extract the content of the LAST \boxed{...}, honoring nested braces.
function lastBoxed(text) {
  const marker = '\\boxed{';
  const start = text.lastIndexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  let depth = 1;
  let out = '';
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
    out += c;
  }
  return depth === 0 ? out.trim() : null;
}

// Ground-truth answer -> {type, answer} in our verifier's zone, or null to skip.
function classifyAnswer(raw) {
  const s = String(raw).trim().replace(/\\[,;!]/g, '').replace(/\s+/g, '');
  if (/^-?\d+(\.\d+)?$/.test(s)) return { type: 'number', answer: s };
  // \frac{a}{b} or a/b
  const frac = s.match(/^\\?frac\{?(-?\d+)\}?\{?(-?\d+)\}?$/) || s.match(/^(-?\d+)\/(-?\d+)$/);
  if (frac) return { type: 'text', answer: `${frac[1]}/${frac[2]}` };
  return null;
}

async function fetchRows(offset) {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(CONFIG.dataset)}`
    + `&config=${encodeURIComponent(CONFIG.config)}&split=${encodeURIComponent(CONFIG.split)}`
    + `&offset=${offset}&length=${CONFIG.pageSize}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ offset ${offset}`);
  const data = await res.json();
  return data.rows || [];
}

async function main() {
  const outDir = join(ROOT, 'training', 'traces');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `raw-r1-${stamp()}.jsonl`);

  console.log(`import-r1-dataset: dataset=${CONFIG.dataset} config=${CONFIG.config} split=${CONFIG.split}`);
  console.log(`  target=${CONFIG.target} candidates, scan<=${CONFIG.maxRows} rows, chars ${CONFIG.minChars}..${CONFIG.maxChars}`);

  const emitted = [];
  const skip = {};
  const bump = (k) => (skip[k] = (skip[k] || 0) + 1);
  let scanned = 0;

  for (let offset = 0; offset < CONFIG.maxRows && emitted.length < CONFIG.target; offset += CONFIG.pageSize) {
    let rows;
    try { rows = await fetchRows(offset); }
    catch (e) { console.error(`  fetch error @ ${offset}: ${(e && e.message) || e}; retrying once`);
      try { rows = await fetchRows(offset); } catch (e2) { console.error(`  gave up @ ${offset}`); break; } }
    if (!rows.length) { console.log(`  no more rows at offset ${offset}`); break; }

    for (const { row } of rows) {
      scanned++;
      const cls = classifyAnswer(row.answer);
      if (!cls) { bump('messy-answer'); continue; }
      const gens = row.generations || [];
      const correct = row.correctness_math_verify || [];
      let gi = correct.findIndex((c) => c === true);
      if (gi === -1) { bump('no-correct-gen'); continue; }
      const gen = String(gens[gi] || '');
      if (!gen.trim()) { bump('empty-gen'); continue; }
      if (gen.includes('<think>') && !gen.includes('</think>')) { bump('truncated-think'); continue; }
      const boxed = lastBoxed(gen);
      if (!boxed) { bump('no-boxed'); continue; }
      // Append R1's OWN answer as the final line so extraction is robust AND the trained
      // model learns our eval's answer format. filter-traces re-verifies it vs ground truth.
      const output = `${gen.trimEnd()}\n\nFinal answer: ${boxed}`;
      if (output.length < CONFIG.minChars) { bump('too-short'); continue; }
      if (output.length > CONFIG.maxChars) { bump('too-long'); continue; }

      emitted.push({
        id: `r1-${row.uuid || scanned}`,
        kind: 'reasoning',
        type: cls.type,
        answer: cls.answer,
        prompt: String(row.problem).trim(),
        teacher: teacherLabel,
        source: CONFIG.dataset,
        output,
      });
      if (emitted.length >= CONFIG.target) break;
    }
    process.stdout.write(`\r  scanned ${scanned} rows, emitted ${emitted.length} candidates ...`);
  }
  process.stdout.write('\n');

  writeFileSync(outPath, emitted.map((t) => JSON.stringify(t)).join('\n') + '\n');
  console.log(`\nEmitted ${emitted.length} candidate traces (scanned ${scanned} rows).`);
  console.log('  skips:', Object.entries(skip).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)');
  console.log(`  wrote ${outPath.replace(ROOT + '/', '')}`);
  console.log(`\nNext: npm run filter:traces -- --in ${outPath.replace(ROOT + '/', '')} --max-chars ${CONFIG.maxChars}`);
}

main().catch((e) => { console.error('import-r1-dataset failed:', (e && e.message) || e); process.exit(1); });
