/**
 * Luigi Codes — long-term memory.
 *
 * Every agent run becomes a TaskRecord that future runs can consult
 * ("have I done something like this before, and how did it go?").
 *
 * Storage is two-tier:
 *   - ChromaDB over its local REST API when a server is running
 *     (luigi.memory.chromaEndpoint, default http://localhost:8000)
 *   - a JSON mirror in the extension's global storage, always written, so
 *     memory works offline and survives Chroma being absent entirely.
 *
 * Similarity uses the router's embedding model when available and falls back
 * to a deterministic bag-of-words vector, so findSimilar() never goes dark.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ModelRouter } from '../inference/modelRouter';

type Logger = (message: string) => void;

export interface TaskRecord {
  id: string;
  timestamp: number;
  prompt: string;
  planSummary: string;
  outcome: string;
  success: boolean;
  filesTouched: string[];
  durationMs: number;
}

interface StoredEntry {
  record: TaskRecord;
  embedding: number[];
}

const COLLECTION = 'luigi-task-memory';
const EMBED_FALLBACK_DIM = 256;
const MAX_LOCAL_ENTRIES = 500;

export class MemorySystem {
  private entries: StoredEntry[] = [];
  private chromaCollectionId: string | undefined;
  private chromaApiBase: string | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly router: ModelRouter,
    private readonly log: Logger
  ) {}

  get status(): 'chroma' | 'local' {
    return this.chromaCollectionId ? 'chroma' : 'local';
  }

  /**
   * Load the local mirror and try to bring the ChromaDB client online.
   * Single-flight: concurrent early callers all await the same load.
   */
  initialize(): Promise<void> {
    this.initPromise ??= (async () => {
      await this.loadLocal();
      await this.initChroma();
    })();
    return this.initPromise;
  }

  // ── ChromaDB client ────────────────────────────────────────────────────────

  private endpoint(): string {
    return vscode.workspace
      .getConfiguration('luigi')
      .get<string>('memory.chromaEndpoint', 'http://localhost:8000')
      .replace(/\/$/, '');
  }

  /**
   * Detect a running Chroma server (v2 API first, legacy v1 second) and
   * get-or-create the Luigi collection.
   */
  private async initChroma(): Promise<void> {
    const base = this.endpoint();
    const apiBases = [
      `${base}/api/v2/tenants/default_tenant/databases/default_database`,
      `${base}/api/v1`,
    ];
    const heartbeats = [`${base}/api/v2/heartbeat`, `${base}/api/v1/heartbeat`];

    for (let i = 0; i < apiBases.length; i++) {
      try {
        const beat = await fetch(heartbeats[i], { signal: AbortSignal.timeout(1500) });
        if (!beat.ok) {
          continue;
        }
        const created = await fetch(`${apiBases[i]}/collections`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: COLLECTION, get_or_create: true }),
          signal: AbortSignal.timeout(3000),
        });
        if (!created.ok) {
          continue;
        }
        const collection = (await created.json()) as { id?: string };
        if (collection.id) {
          this.chromaApiBase = apiBases[i];
          this.chromaCollectionId = collection.id;
          this.log(`Memory: ChromaDB online (${i === 0 ? 'v2' : 'v1'} API).`);
          return;
        }
      } catch {
        // server absent on this API version — try the next, then fall back
      }
    }
    this.log('Memory: no ChromaDB server; using local persistence.');
  }

  // ── Write path ─────────────────────────────────────────────────────────────

  async storeTask(record: TaskRecord): Promise<void> {
    await this.initialize();
    const embedding = await this.embed(this.textOf(record));
    this.entries.push({ record, embedding });
    if (this.entries.length > MAX_LOCAL_ENTRIES) {
      this.entries = this.entries.slice(-MAX_LOCAL_ENTRIES);
    }
    await this.saveLocal();

    if (this.chromaCollectionId && this.chromaApiBase) {
      try {
        await fetch(`${this.chromaApiBase}/collections/${this.chromaCollectionId}/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: [record.id],
            embeddings: [embedding],
            documents: [this.textOf(record)],
            metadatas: [{ record: JSON.stringify(record) }],
          }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        this.log(`Memory: Chroma add failed (${describe(error)}); local mirror has it.`);
      }
    }
  }

  // ── Read paths ─────────────────────────────────────────────────────────────

  /** Semantic nearest-neighbors over past tasks. */
  async findSimilar(query: string, limit = 3): Promise<TaskRecord[]> {
    await this.initialize();
    if (this.entries.length === 0 && !this.chromaCollectionId) {
      return [];
    }
    const queryEmbedding = await this.embed(query);

    if (this.chromaCollectionId && this.chromaApiBase) {
      try {
        const response = await fetch(
          `${this.chromaApiBase}/collections/${this.chromaCollectionId}/query`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query_embeddings: [queryEmbedding],
              n_results: limit,
              include: ['metadatas'],
            }),
            signal: AbortSignal.timeout(5000),
          }
        );
        if (response.ok) {
          const data = (await response.json()) as {
            metadatas?: { record?: string }[][];
          };
          const records: TaskRecord[] = [];
          for (const metadata of data.metadatas?.[0] ?? []) {
            if (metadata?.record) {
              try {
                records.push(JSON.parse(metadata.record) as TaskRecord);
              } catch {
                // malformed metadata — skip
              }
            }
          }
          if (records.length > 0) {
            return records;
          }
        }
      } catch (error) {
        this.log(`Memory: Chroma query failed (${describe(error)}); using local mirror.`);
      }
    }

    // Local cosine ranking over the mirror. Drop zero-similarity entries so a
    // dimension mismatch (model vector stored, hash query) or a truly
    // unrelated query returns nothing rather than arbitrary records.
    return this.entries
      .map((entry) => ({ record: entry.record, score: cosine(queryEmbedding, entry.embedding) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.record);
  }

  /** Chronological history, newest first. */
  getTaskHistory(limit = 20): TaskRecord[] {
    return [...this.entries]
      .sort((a, b) => b.record.timestamp - a.record.timestamp)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

  // ── Embeddings ─────────────────────────────────────────────────────────────

  private async embed(text: string): Promise<number[]> {
    const vector = await this.router.embed(text);
    if (vector && vector.length > 0) {
      return vector;
    }
    return hashEmbedding(text);
  }

  private textOf(record: TaskRecord): string {
    return `${record.prompt}\n${record.planSummary}\n${record.outcome}`;
  }

  // ── Local persistence ──────────────────────────────────────────────────────

  private get localFile(): string {
    return path.join(this.storageUri.fsPath, 'memory.json');
  }

  private async loadLocal(): Promise<void> {
    try {
      const raw = await fs.readFile(this.localFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const loaded = parsed.filter(
          (item): item is StoredEntry =>
            !!item &&
            typeof item === 'object' &&
            !!(item as StoredEntry).record &&
            Array.isArray((item as StoredEntry).embedding)
        );
        // Persisted history goes UNDER anything stored before the load
        // finished, so an early write is never clobbered.
        this.entries = [...loaded, ...this.entries];
        this.log(`Memory: loaded ${loaded.length} task(s) from local store.`);
      }
    } catch {
      // first run — no local file yet; keep whatever is already in memory
    }
  }

  private async saveLocal(): Promise<void> {
    try {
      await fs.mkdir(this.storageUri.fsPath, { recursive: true });
      await fs.writeFile(this.localFile, JSON.stringify(this.entries), 'utf8');
    } catch (error) {
      this.log(`Memory: local save failed: ${describe(error)}`);
    }
  }
}

// ── Vector fallbacks ────────────────────────────────────────────────────────

/**
 * Deterministic bag-of-words vector. Far weaker than a real embedding model,
 * but keeps similarity search functional with zero infrastructure.
 */
function hashEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBED_FALLBACK_DIM).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 3) {
      continue;
    }
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % EMBED_FALLBACK_DIM] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

function cosine(a: number[], b: number[]): number {
  // Different lengths mean different embedding spaces (model vector vs hash
  // fallback) — similarity between them is noise, not signal.
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
