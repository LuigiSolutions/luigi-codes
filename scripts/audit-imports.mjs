#!/usr/bin/env node
/**
 * Import audit: every import in src TypeScript files must resolve, and the
 * relative import graph must contain zero cycles. Exit 1 on any violation.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { builtinModules } from 'module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const declaredPackages = new Set([
  'vscode', // provided by the extension host, not npm
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...walk(full));
    } else if (name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function importsOf(file) {
  const text = readFileSync(file, 'utf8');
  const specs = [];
  for (const match of text.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[\w${},*\s]*?(?:from\s+)?['"]([^'"]+)['"]/g)) {
    specs.push(match[1]);
  }
  for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specs.push(match[1]);
  }
  return specs;
}

const files = walk(srcDir);
const errors = [];
const graph = new Map(); // absolute file → absolute imported files

for (const file of files) {
  const edges = [];
  for (const spec of importsOf(file)) {
    if (spec.startsWith('.')) {
      const base = path.resolve(path.dirname(file), spec);
      const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')];
      const hit = candidates.find((c) => existsSync(c));
      if (!hit) {
        errors.push(`${path.relative(root, file)}: unresolved relative import "${spec}"`);
      } else {
        edges.push(hit);
      }
    } else {
      const top = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      if (!builtins.has(top) && !declaredPackages.has(top)) {
        errors.push(`${path.relative(root, file)}: undeclared package import "${spec}"`);
      }
    }
  }
  graph.set(file, edges);
}

// Cycle detection — iterative DFS with colors.
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map(files.map((f) => [f, WHITE]));
function findCycle(start) {
  const stack = [[start, 0]];
  const trail = [start];
  color.set(start, GRAY);
  while (stack.length > 0) {
    const [node, i] = stack[stack.length - 1];
    const edges = graph.get(node) ?? [];
    if (i >= edges.length) {
      stack.pop();
      trail.pop();
      color.set(node, BLACK);
      continue;
    }
    stack[stack.length - 1][1]++;
    const next = edges[i];
    if (color.get(next) === GRAY) {
      const cycleStart = trail.indexOf(next);
      return [...trail.slice(cycleStart), next];
    }
    if (color.get(next) === WHITE) {
      color.set(next, GRAY);
      stack.push([next, 0]);
      trail.push(next);
    }
  }
  return undefined;
}
for (const file of files) {
  if (color.get(file) === WHITE) {
    const cycle = findCycle(file);
    if (cycle) {
      errors.push(`Circular import: ${cycle.map((f) => path.relative(root, f)).join(' → ')}`);
    }
  }
}

let importCount = 0;
for (const edges of graph.values()) importCount += edges.length;

if (errors.length > 0) {
  console.error(`IMPORT AUDIT FAILED (${errors.length} problem(s)):`);
  for (const error of errors) console.error(`  ✗ ${error}`);
  process.exit(1);
}
console.log(
  `Import audit passed: ${files.length} files, ${importCount} relative imports resolved, zero cycles.`
);
