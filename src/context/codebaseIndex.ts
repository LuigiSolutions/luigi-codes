/**
 * Luigi Codes — codebase index.
 *
 * Gives the agent a mental map of the workspace: every source file's symbols,
 * imports, and (lazily) an embedding vector for semantic retrieval.
 *
 * Symbol extraction uses fast per-language structural parsers over source
 * text. The parser layer is deliberately pluggable — swap `parseSymbols` for
 * a tree-sitter backend later without touching any caller; the index shape
 * (SymbolInfo/FileIndexEntry) is already AST-grade. Zero native dependencies
 * keeps install friction at zero today.
 *
 * Retrieval strategy: lexical scoring always works; when the local embedding
 * model is reachable, the top lexical candidates are re-ranked by cosine
 * similarity for true semantic matching.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import { ModelRouter } from '../inference/modelRouter';

type Logger = (message: string) => void;

export interface SymbolInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'constant' | 'method';
  file: string;
  line: number;
}

export interface FileIndexEntry {
  path: string;
  language: string;
  lineCount: number;
  symbols: SymbolInfo[];
  imports: string[];
  /** First ~40 lines — cheap context for ranking and prompts. */
  preview: string;
  embedding?: number[];
}

export interface IndexStats {
  fileCount: number;
  symbolCount: number;
  language: string;
}

export interface CodebasePatterns {
  dominantLanguage: string;
  frameworks: string[];
  conventions: string[];
  summary: string;
}

const INDEX_GLOB =
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,swift,kt,c,cpp,h,hpp}';
const EXCLUDED_DIRS = [
  'node_modules', 'out', 'dist', 'build', '.git', 'target', 'vendor',
  '__pycache__', '.next', 'coverage',
];
const INDEX_EXCLUDE = `**/{${EXCLUDED_DIRS.join(',')}}/**`;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 262144; // 256 KB — larger files are almost never hand-written source

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.rb': 'ruby',
  '.php': 'php',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
};

export class CodebaseIndex implements vscode.Disposable {
  private readonly entries = new Map<string, FileIndexEntry>();
  private readonly updated = new vscode.EventEmitter<IndexStats>();
  readonly onDidUpdate: vscode.Event<IndexStats> = this.updated.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private indexing = false;

  constructor(
    private readonly router: ModelRouter,
    private readonly log: Logger
  ) {}

  dispose(): void {
    this.watcher?.dispose();
    this.updated.dispose();
    this.entries.clear();
  }

  get stats(): IndexStats {
    let symbolCount = 0;
    for (const entry of this.entries.values()) {
      symbolCount += entry.symbols.length;
    }
    return {
      fileCount: this.entries.size,
      symbolCount,
      language: this.dominantLanguage(),
    };
  }

  // ── Indexing ───────────────────────────────────────────────────────────────

  /** Full workspace sweep + a watcher for incremental updates on change. */
  async indexWorkspace(): Promise<IndexStats> {
    if (this.indexing) {
      return this.stats;
    }
    this.indexing = true;
    try {
      this.entries.clear();
      const uris = await vscode.workspace.findFiles(INDEX_GLOB, INDEX_EXCLUDE, MAX_FILES);
      // Batched reads: fast without starving the extension host.
      const batchSize = 32;
      for (let i = 0; i < uris.length; i += batchSize) {
        await Promise.all(uris.slice(i, i + batchSize).map((uri) => this.indexFile(uri)));
      }
      this.ensureWatcher();
      const stats = this.stats;
      this.updated.fire(stats);
      return stats;
    } finally {
      this.indexing = false;
    }
  }

  private ensureWatcher(): void {
    if (this.watcher) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(INDEX_GLOB);
    // The watcher API takes no exclude glob, so events must be filtered here —
    // an `npm install` would otherwise flood the index with node_modules and
    // blow straight past MAX_FILES.
    const refresh = async (uri: vscode.Uri): Promise<void> => {
      const relative = vscode.workspace.asRelativePath(uri, false);
      if (EXCLUDED_DIRS.some((dir) => relative.split('/').includes(dir))) {
        return;
      }
      if (this.entries.size >= MAX_FILES && !this.entries.has(relative)) {
        return;
      }
      await this.indexFile(uri);
      this.updated.fire(this.stats);
    };
    this.watcher.onDidChange((uri) => void refresh(uri));
    this.watcher.onDidCreate((uri) => void refresh(uri));
    this.watcher.onDidDelete((uri) => {
      this.entries.delete(vscode.workspace.asRelativePath(uri, false));
      this.updated.fire(this.stats);
    });
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    const relative = vscode.workspace.asRelativePath(uri, false);
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        // A file that grew past the cap must not keep serving its stale
        // pre-growth symbols on every subsequent watcher refresh.
        this.entries.delete(relative);
        return;
      }
      const text = Buffer.from(bytes).toString('utf8');
      const language = EXT_LANGUAGE[path.extname(relative).toLowerCase()] ?? 'plaintext';
      const lines = text.split('\n');
      this.entries.set(relative, {
        path: relative,
        language,
        lineCount: lines.length,
        symbols: parseSymbols(text, language, relative),
        imports: parseImports(text, language),
        preview: lines.slice(0, 40).join('\n'),
      });
    } catch {
      this.entries.delete(relative);
    }
  }

  // ── Retrieval ──────────────────────────────────────────────────────────────

  /**
   * Rank files against a natural-language query. Lexical first (always
   * available), then embedding re-rank of the top candidates when the local
   * embedding model answers.
   */
  async findRelevantFiles(query: string, limit = 5): Promise<FileIndexEntry[]> {
    if (this.entries.size === 0) {
      return [];
    }
    const terms = tokenize(query);
    const scored = [...this.entries.values()]
      .map((entry) => ({ entry, score: lexicalScore(entry, terms) }))
      .sort((a, b) => b.score - a.score);

    const shortlist = scored.slice(0, Math.max(limit * 6, 24)).filter((s) => s.score > 0);
    if (shortlist.length === 0) {
      // Nothing matched — returning arbitrary map-order files as "relevant"
      // would mislead the planner. Better to admit no match.
      return [];
    }

    const queryVector = await this.router.embed(query);
    if (queryVector) {
      // Fill missing embeddings for just the shortlist — lazy and cheap.
      await Promise.all(
        shortlist.map(async ({ entry }) => {
          if (!entry.embedding) {
            entry.embedding = await this.router.embed(
              `${entry.path}\n${entry.symbols.map((s) => s.name).join(' ')}\n${entry.preview}`
            );
          }
        })
      );
      for (const item of shortlist) {
        // Blend ALL items on one scale. A file whose embedding failed to
        // compute keeps only its (scaled) lexical score — it must not retain a
        // raw, larger-scale score and thereby outrank a true semantic match.
        const sim = item.entry.embedding ? cosine(queryVector, item.entry.embedding) : undefined;
        item.score = blendScore(item.score, sim);
      }
      shortlist.sort((a, b) => b.score - a.score);
    }
    return shortlist.slice(0, limit).map((s) => s.entry);
  }

  // ── Analysis ───────────────────────────────────────────────────────────────

  /** What kind of codebase is this? Feeds every planning prompt. */
  extractPatterns(): CodebasePatterns {
    const dominantLanguage = this.dominantLanguage();
    const externalImports = new Map<string, number>();
    let camel = 0;
    let snake = 0;
    let testFiles = 0;

    for (const entry of this.entries.values()) {
      for (const spec of entry.imports) {
        if (!spec.startsWith('.')) {
          const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
          externalImports.set(pkg, (externalImports.get(pkg) ?? 0) + 1);
        }
      }
      for (const symbol of entry.symbols) {
        if (/_[a-z]/.test(symbol.name)) {
          snake++;
        } else if (/[a-z][A-Z]/.test(symbol.name)) {
          camel++;
        }
      }
      if (/\.(test|spec)\.|_test\.|test_/.test(entry.path)) {
        testFiles++;
      }
    }

    const KNOWN_FRAMEWORKS = [
      'react', 'next', 'vue', 'svelte', 'express', 'fastify', 'nestjs', '@nestjs/core',
      'django', 'flask', 'fastapi', 'rails', 'spring', 'jest', 'vitest', 'mocha',
      'pytest', 'tailwindcss', 'electron', 'vscode',
    ];
    const frameworks = KNOWN_FRAMEWORKS.filter((f) => externalImports.has(f));

    const conventions: string[] = [];
    if (camel + snake > 10) {
      conventions.push(camel >= snake ? 'camelCase naming' : 'snake_case naming');
    }
    conventions.push(
      testFiles > 0 ? `${testFiles} test file(s) present` : 'no test files detected'
    );

    const summary =
      this.entries.size === 0
        ? 'Workspace not indexed yet.'
        : `${this.entries.size} source files, mostly ${dominantLanguage}.` +
          (frameworks.length > 0 ? ` Uses ${frameworks.join(', ')}.` : '') +
          ` Conventions: ${conventions.join('; ')}.`;

    return { dominantLanguage, frameworks, conventions, summary };
  }

  private dominantLanguage(): string {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      counts.set(entry.language, (counts.get(entry.language) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [language, count] of counts) {
      if (count > bestCount) {
        best = language;
        bestCount = count;
      }
    }
    return best;
  }
}

// ── Structural parsing (pluggable — see file header) ────────────────────────

interface SymbolPattern {
  kind: SymbolInfo['kind'];
  pattern: RegExp;
}

const LANGUAGE_PATTERNS: Record<string, SymbolPattern[]> = {
  typescript: [
    { kind: 'class', pattern: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'interface', pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'type', pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'enum', pattern: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
    { kind: 'function', pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/ },
    { kind: 'constant', pattern: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=/ },
  ],
  python: [
    { kind: 'class', pattern: /^\s*class\s+([A-Za-z_]\w*)/ },
    { kind: 'function', pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  ],
  go: [
    { kind: 'function', pattern: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
    { kind: 'type', pattern: /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/ },
  ],
  rust: [
    { kind: 'function', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
    { kind: 'class', pattern: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
    { kind: 'enum', pattern: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', pattern: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
  ],
  java: [
    { kind: 'class', pattern: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+([A-Za-z_]\w*)/ },
    { kind: 'interface', pattern: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/ },
  ],
};
LANGUAGE_PATTERNS.javascript = LANGUAGE_PATTERNS.typescript;
LANGUAGE_PATTERNS.csharp = LANGUAGE_PATTERNS.java;
LANGUAGE_PATTERNS.kotlin = LANGUAGE_PATTERNS.java;

function parseSymbols(text: string, language: string, file: string): SymbolInfo[] {
  const patterns = LANGUAGE_PATTERNS[language];
  if (!patterns) {
    return [];
  }
  const symbols: SymbolInfo[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && symbols.length < 200; i++) {
    for (const { kind, pattern } of patterns) {
      const match = lines[i].match(pattern);
      if (match) {
        symbols.push({ name: match[1], kind, file, line: i + 1 });
        break;
      }
    }
  }
  return symbols;
}

function parseImports(text: string, language: string): string[] {
  const imports = new Set<string>();
  const add = (spec: string | undefined): void => {
    if (spec && spec.length > 0 && imports.size < 100) {
      imports.add(spec);
    }
  };
  if (language === 'typescript' || language === 'javascript') {
    for (const match of text.matchAll(/import\s+(?:[\w${},*\s]+\s+from\s+)?['"]([^'"]+)['"]/g)) {
      add(match[1]);
    }
    for (const match of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      add(match[1]);
    }
  } else if (language === 'python') {
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      add(match[1] ?? match[2]);
    }
  } else if (language === 'go') {
    for (const match of text.matchAll(/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"\s*$/gm)) {
      add(match[1]);
    }
  } else if (language === 'rust') {
    for (const match of text.matchAll(/^\s*use\s+([\w:]+)/gm)) {
      add(match[1].split('::')[0]);
    }
  }
  return [...imports];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2)
    ),
  ];
}

function lexicalScore(entry: FileIndexEntry, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const pathText = entry.path.toLowerCase();
  const symbolText = entry.symbols.map((s) => s.name.toLowerCase()).join(' ');
  const previewText = entry.preview.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (pathText.includes(term)) {
      score += 3;
    }
    if (symbolText.includes(term)) {
      score += 2;
    }
    if (previewText.includes(term)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Combine a lexical score with an optional semantic similarity onto one scale.
 * The lexical term is always weighted the same; the semantic bonus (cosine,
 * non-negative here) is added only when an embedding exists — so a missing
 * embedding can never inflate a file above a genuine semantic match.
 */
export function blendScore(lexical: number, cosineSim: number | undefined): number {
  return lexical * 0.4 + (cosineSim ?? 0) * 10;
}

function cosine(a: number[], b: number[]): number {
  // Vectors from different embedding spaces are incomparable — score 0.
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  const length = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
