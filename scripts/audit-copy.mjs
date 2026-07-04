#!/usr/bin/env node
/**
 * Copy audit: no em dash (U+2014) may ever reach a user-facing surface.
 * Owner rule (2026-07-04): em dashes are banned from everything displayed
 * on the site, in the app, and in emails.
 *
 * Scope:
 *   site + media (.html/.svg/.css)  -> whole file (all of it can render)
 *   api .js and src .ts files       -> string literals only (comments are
 *                                      not displayed), src/test excluded
 *   package.json                    -> whole file (titles/descriptions
 *                                      render in the VS Code UI)
 *
 * Exit 1 on any violation.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EM_DASH = '—';

function walk(dir, extensions) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'out', '.git', '.vscode-test'].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, extensions));
    } else if (extensions.some((ext) => name.endsWith(ext))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Return the offsets of every character that sits inside a string literal
 * (' " or `), skipping comments, regex bodies are treated as code. Template
 * literal ${...} interpolations are treated as code (recursively scanned by
 * the same state machine).
 */
function stringLiteralRanges(source) {
  const ranges = [];
  // Stack of states so template interpolations nest: 'code' | '/*' | '//' |
  // "'" | '"' | '`'
  const stack = ['code'];
  let start = -1;
  for (let i = 0; i < source.length; i++) {
    const state = stack[stack.length - 1];
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { stack.push('//'); i++; continue; }
      if (ch === '/' && next === '*') { stack.push('/*'); i++; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); start = i + 1; continue; }
      if (ch === '}' && stack.length > 1) { stack.pop(); start = i + 1; continue; } // end of ${ }
      continue;
    }
    if (state === '//') { if (ch === '\n') stack.pop(); continue; }
    if (state === '/*') { if (ch === '*' && next === '/') { stack.pop(); i++; } continue; }
    // Inside a string literal.
    if (ch === '\\') { i++; continue; }
    if (state === '`' && ch === '$' && next === '{') {
      ranges.push([start, i]);
      stack.push('code');
      i++;
      continue;
    }
    if (ch === state || (state === '`' && ch === '`') ) {
      if (ch === state) { ranges.push([start, i]); stack.pop(); }
      continue;
    }
    if (state !== '`' && ch === '\n') { stack.pop(); continue; } // unterminated; be lenient
  }
  return ranges;
}

function lineOf(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

const errors = [];

// Whole-file surfaces.
const wholeFiles = [
  ...walk(path.join(root, 'site'), ['.html', '.css', '.svg']),
  ...walk(path.join(root, 'media'), ['.html', '.css', '.svg']),
  path.join(root, 'package.json'),
];
for (const file of wholeFiles) {
  const text = readFileSync(file, 'utf8');
  let index = text.indexOf(EM_DASH);
  while (index !== -1) {
    errors.push(`${path.relative(root, file)}:${lineOf(text, index)}: em dash in displayed content`);
    index = text.indexOf(EM_DASH, index + 1);
  }
}

// String-literal surfaces (displayed copy lives in strings; comments do not render).
const codeFiles = [
  ...walk(path.join(root, 'src'), ['.ts']).filter((f) => !f.includes(`${path.sep}test${path.sep}`)),
  ...walk(path.join(root, 'api'), ['.js']),
];
for (const file of codeFiles) {
  const text = readFileSync(file, 'utf8');
  for (const [from, to] of stringLiteralRanges(text)) {
    const segment = text.slice(from, to);
    let at = segment.indexOf(EM_DASH);
    while (at !== -1) {
      errors.push(`${path.relative(root, file)}:${lineOf(text, from + at)}: em dash in string literal`);
      at = segment.indexOf(EM_DASH, at + 1);
    }
  }
}

if (errors.length > 0) {
  console.error(`COPY AUDIT FAILED (${errors.length} em dash(es) in displayed copy):`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
console.log(
  `Copy audit passed: ${wholeFiles.length + codeFiles.length} files scanned, zero em dashes in displayed copy.`
);
