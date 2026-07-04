#!/usr/bin/env node
/**
 * Brand audit: every hex and rgba() in src/, media/, and package.json must be
 * on the Luigi Solutions palette (luigi-os/packages/ui/src/theme.css) or one
 * of the derived steps documented in src/ui/designTokens.ts. Exit 1 otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Core palette (theme.css) + derived steps (designTokens.ts). */
const ALLOWED_HEX = new Set([
  '#0b0a09', // canvas
  '#16140f', // surface
  '#1d1a14', // derived: tertiary
  '#242019', // derived: elevated
  '#f3efe7', // ink
  '#9c948a', // ink-muted
  '#6e675e', // ink-faint
  '#c9a86a', // gold — THE accent
  '#dcc18d', // derived: gold light
  '#a8874d', // derived: gold dark
  '#a3c585', // success
  '#e8796e', // danger
  '#d9924a', // warning
  '#8fb5c9', // info
]);

/** rgba() is allowed only in the gold, ink, and pure-black families. */
const ALLOWED_RGBA_FAMILIES = [
  /^rgba\(\s*201\s*,\s*168\s*,\s*106\s*,/, // gold
  /^rgba\(\s*243\s*,\s*239\s*,\s*231\s*,/, // ink
  /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,/, // black (shadows)
];

function walk(dir, extensions) {
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

const targets = [
  ...walk(path.join(root, 'src'), ['.ts']),
  ...walk(path.join(root, 'media'), ['.svg', '.css', '.html']),
  ...walk(path.join(root, 'site'), ['.svg', '.css', '.html']),
  path.join(root, 'package.json'),
];

const errors = [];
let hexCount = 0;
let rgbaCount = 0;

for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const hex of line.match(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])|#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g) ?? []) {
      hexCount++;
      if (!ALLOWED_HEX.has(hex.toLowerCase())) {
        errors.push(`${relative}:${i + 1}: off-palette hex ${hex}`);
      }
    }
    for (const rgba of line.match(/rgba?\([^)]*\)/g) ?? []) {
      rgbaCount++;
      if (!ALLOWED_RGBA_FAMILIES.some((family) => family.test(rgba))) {
        errors.push(`${relative}:${i + 1}: off-palette ${rgba}`);
      }
    }
  });
}

if (errors.length > 0) {
  console.error(`BRAND AUDIT FAILED (${errors.length} violation(s)):`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
console.log(
  `Brand audit passed: ${targets.length} files scanned, ${hexCount} hex + ${rgbaCount} rgba values, all on-palette.`
);
