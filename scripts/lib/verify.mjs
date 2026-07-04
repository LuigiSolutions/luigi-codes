// Shared verifier for Luigi Codes: answer extraction, matching, and code execution.
// Used by both the eval harness (scripts/eval.mjs) and the distillation filter
// (scripts/filter-traces.mjs), so a teacher trace is judged by the exact same
// rules that score a model. Pure functions plus one sandboxed JS runner; no I/O
// beyond a temp file, no runtime deps.

import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Reasoning-distilled models (DeepSeek-R1 distills, QwQ) emit a long <think>...</think>
// chain before the answer. Score only the post-reasoning text, or the chain's own
// numbers corrupt answer extraction. If the closing tag is missing (model ran out of
// tokens mid-thought) leave the text as-is.
export function stripThinkBlocks(text) {
  const close = text.lastIndexOf('</think>');
  return close === -1 ? text : text.slice(close + '</think>'.length).trim();
}

// Some raw servers (mlx-lm observed on :8080) leak chat-template stop markers as
// literal text at the end of a reply. Strip them or a correct "wednesday<|im_end|>"
// scores as wrong.
export const STOP_MARKERS = ['<|im_end|>', '<|endoftext|>', '<|eot_id|>', '<|eom_id|>', '<|end|>', '</s>'];
export function stripStopMarkers(text) {
  let out = text;
  for (const marker of STOP_MARKERS) {
    const i = out.indexOf(marker);
    if (i !== -1) out = out.slice(0, i);
  }
  return out.trim();
}

export function extractCode(text) {
  // Prefer the longest fenced block; fall back to the raw text.
  const blocks = [...text.matchAll(/```(?:[a-zA-Z0-9]*)\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length) return blocks.sort((a, b) => b.length - a.length)[0].trim();
  return text.trim();
}

export function runJs(code, tests) {
  const file = join(tmpdir(), `luigi-verify-${process.pid}-${Math.floor(performance.now())}.mjs`);
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

export function canonicalizeMath(s) {
  // Fold common LaTeX / markdown answer formatting so 3/10 == \frac{3}{10} == **3/10**.
  return String(s)
    .replace(/\\frac\s*\{\s*(-?\d+)\s*\}\s*\{\s*(-?\d+)\s*\}/g, '$1/$2')
    .replace(/\\[a-z()[\]]+/gi, '')   // stray LaTeX commands / delimiters
    .replace(/[\\${}()[\]]/g, '')
    .replace(/[*_`#]/g, '');          // markdown emphasis (reasoning models bold answers)
}

export function normalizeAnswer(s) {
  return canonicalizeMath(s).toLowerCase().replace(/[\s,]/g, '').replace(/[.]$/, '').trim();
}

export function extractFinalAnswer(text) {
  // Drop markdown emphasis first, so "**Final answer:**" and "**60**" read cleanly.
  const clean = text.replace(/[*`#]/g, '');
  // Take the last "Final answer:" whose captured value is non-empty. A bolded header
  // like "**Final answer:**\n60" leaves the value on the next line, so fall through.
  const matches = [...clean.matchAll(/final answer\s*[:\-]?\s*([^\n]*)/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const v = matches[i][1].trim();
    if (v) return v;
  }
  const lines = clean.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// Vote key for self-consistency: numeric tasks collapse to their number, text to normalized.
export function answerKey(raw, task) {
  if (task.type === 'number') {
    const nums = String(raw).match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length) return String(Number(nums[nums.length - 1]));
  }
  return normalizeAnswer(raw);
}

export function answerMatches(candidate, task) {
  if (task.type === 'number') {
    const expected = Number(task.answer);
    const nums = String(candidate).match(/-?\d+(?:\.\d+)?/g);
    if (nums && nums.length) {
      const got = Number(nums[nums.length - 1]);
      return Math.abs(got - expected) < 1e-6;
    }
    return false;
  }
  // text
  const na = normalizeAnswer(candidate);
  const nb = normalizeAnswer(task.answer);
  if (na === nb) return true;
  // Whole-word match in the raw answer, so "...is a Wednesday" counts for "wednesday"
  // but "the answer is knight" does not match "knave" via a stray substring.
  const esc = String(task.answer).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(String(candidate))) return true;
  // Fractions may sit inside a longer stated answer, e.g. "= 6/36 = 1/6".
  if (String(task.answer).includes('/') && na.includes(nb)) return true;
  // Fraction equivalence: a correct-but-unreduced 286/5525 equals 22/425.
  const fe = String(task.answer).match(/^(-?\d+)\/(-?\d+)$/);
  if (fe) {
    const en = Number(fe[1]), ed = Number(fe[2]);
    const cands = canonicalizeMath(String(candidate)).match(/-?\d+\/-?\d+/g) || [];
    for (const c of cands) {
      const [cn, cd] = c.split('/').map(Number);
      if (cd !== 0 && en * cd === ed * cn) return true;
    }
  }
  return false;
}
