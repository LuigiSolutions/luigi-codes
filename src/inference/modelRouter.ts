/**
 * Luigi Codes — model router.
 *
 * One brain, many local models. The router keeps a registry of model
 * profiles, probes the local inference server (Ollama or any
 * OpenAI-compatible endpoint like LM Studio) for what is actually installed,
 * scores candidates per task, and streams completions. Every run feeds
 * recordPerformance() so routing improves with use — the first loop of
 * Luigi's self-improvement story.
 */
import * as vscode from 'vscode';
import { ndjsonLines, parseSseChunk, splitAtStopMarker } from './streamText';

// Re-exported so existing consumers (tests, chat surfaces) keep one import site.
export { parseSseChunk } from './streamText';

type Logger = (message: string) => void;

export type TaskKind =
  | 'code-generation'
  | 'code-explanation'
  | 'code-review'
  | 'test-generation'
  | 'bug-fixing'
  | 'planning'
  | 'chat'
  | 'embedding';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelProfile {
  /** Provider model id, e.g. "deepseek-coder:6.7b". */
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  strengths: TaskKind[];
  /** 1 (slow) … 5 (instant). */
  speed: number;
  /** 1 (weak) … 5 (frontier-local). */
  quality: number;
  available: boolean;
}

export interface TaskRequest {
  description?: string;
  kind?: TaskKind;
  /** Rough prompt size in characters, used to prefer larger context windows. */
  sizeHint?: number;
}

export interface RoutedModel {
  model: ModelProfile;
  kind: TaskKind;
  reason: string;
}

export interface GenerationMetrics {
  modelId: string;
  taskKind: TaskKind;
  latencyMs: number;
  tokensPerSecond: number;
  success: boolean;
}

interface ChatOptions {
  taskKind?: TaskKind;
  onToken?: (token: string) => void;
  /** Fired with the model actually chosen, before the request is sent. */
  onRouted?: (model: ModelProfile) => void;
  signal?: AbortSignal;
}

/**
 * Task keywords used by route()'s analysis when no explicit kind is given.
 * Patterns match common inflections (plural/-ed/-ing) — real requests say
 * "fixing the bugs", "writing a parser", "explains", not just the base verb,
 * and a miss routes the task to a less-suitable local model.
 */
const KIND_SIGNALS: [TaskKind, RegExp][] = [
  ['test-generation', /\b(tests?|specs?|coverage|unit test|jest|pytest|vitest)\b/i],
  ['bug-fixing', /\b(bugs?|fix(es|ed|ing)?|broken|crash(es|ed|ing)?|errors?|exceptions?|fail(s|ed|ing)?|debug(ging)?)\b/i],
  ['code-review', /\b(review(s|ed|ing)?|audit(s|ed|ing)?|critique|feedback)\b/i],
  ['code-explanation', /\b(explain(s|ed|ing)?|understand|what does|how does|walk (me )?through)\b/i],
  ['planning', /\b(plan(s|ned|ning)?|design(s|ed|ing)?|architect|steps?|approach|strategy)\b/i],
  ['code-generation', /\b(writ(e|es|ing)|creat(e|es|ing)|implement(s|ed|ing)?|build(s|ing)?|generat(e|es|ing)|refactor(s|ed|ing)?|add(s|ing)?|improv(e|es|ing))\b/i],
];

export class ModelRouter implements vscode.Disposable {
  private readonly registry = new Map<string, ModelProfile>();
  private readonly metrics = new Map<string, GenerationMetrics[]>();
  private lastDetection = 0;

  constructor(private readonly log: Logger) {
    // Curated defaults — profiles for the models Luigi recommends. Detection
    // flips `available` and augments this list with whatever else is installed.
    this.registerModel({
      id: 'deepseek-coder:6.7b',
      name: 'DeepSeek Coder 6.7B',
      family: 'deepseek',
      contextWindow: 16384,
      strengths: ['code-generation', 'bug-fixing', 'test-generation'],
      speed: 4,
      quality: 3,
      available: false,
    });
    this.registerModel({
      id: 'codellama:13b',
      name: 'Code Llama 13B',
      family: 'llama',
      contextWindow: 16384,
      strengths: ['code-generation', 'code-explanation'],
      speed: 2,
      quality: 3,
      available: false,
    });
    this.registerModel({
      id: 'qwen2.5-coder:7b',
      name: 'Qwen 2.5 Coder 7B',
      family: 'qwen',
      contextWindow: 32768,
      strengths: ['code-generation', 'code-review', 'bug-fixing', 'planning'],
      speed: 4,
      quality: 4,
      available: false,
    });
    this.registerModel({
      id: 'llama3.1:8b',
      name: 'Llama 3.1 8B',
      family: 'llama',
      contextWindow: 131072,
      strengths: ['chat', 'code-explanation', 'planning'],
      speed: 4,
      quality: 3,
      available: false,
    });
    this.registerModel({
      id: 'nomic-embed-text',
      name: 'Nomic Embed Text',
      family: 'nomic',
      contextWindow: 8192,
      strengths: ['embedding'],
      speed: 5,
      quality: 3,
      available: false,
    });
  }

  dispose(): void {
    this.registry.clear();
    this.metrics.clear();
  }

  registerModel(profile: ModelProfile): void {
    this.registry.set(profile.id, profile);
  }

  get models(): ModelProfile[] {
    return [...this.registry.values()];
  }

  statusSummary(): string {
    const available = this.models.filter((m) => m.available);
    if (available.length === 0) {
      return 'no models — start Ollama';
    }
    const preferred = this.route({ kind: 'code-generation' }).model.id;
    return `${available.length} model${available.length === 1 ? '' : 's'} · ${preferred}`;
  }

  // ── Detection ──────────────────────────────────────────────────────────────

  /** Probe the local server for installed models; registers unknown ones. */
  async detectAvailableModels(): Promise<ModelProfile[]> {
    const { provider, endpoint } = this.config();
    let installed: string[] = [];
    try {
      if (provider === 'ollama') {
        const response = await fetch(`${endpoint}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as { models?: { name: string }[] };
        installed = (data.models ?? []).map((m) => m.name);
      } else {
        // LM Studio and "custom" speak the OpenAI wire format.
        const response = await fetch(`${endpoint}/v1/models`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as { data?: { id: string }[] };
        installed = (data.data ?? []).map((m) => m.id);
      }
    } catch (error) {
      this.log(`Model detection: ${endpoint} unreachable (${describe(error)}).`);
      for (const model of this.registry.values()) {
        model.available = false;
      }
      this.lastDetection = Date.now();
      return [];
    }

    const installedSet = new Set(installed);
    for (const model of this.registry.values()) {
      // Exact id, or ":latest" for untagged pulls. An untagged profile id may
      // match any tag of the same base name; a tagged one must match exactly —
      // otherwise having deepseek-coder:33b would mark :6.7b available and
      // route requests to a model the server does not have.
      model.available =
        installedSet.has(model.id) ||
        installedSet.has(`${model.id}:latest`) ||
        (!model.id.includes(':') && installed.some((name) => name.split(':')[0] === model.id));
    }
    for (const id of installed) {
      if (!this.registry.has(id)) {
        this.registerModel(this.inferProfile(id));
      }
    }
    this.lastDetection = Date.now();
    return this.models.filter((m) => m.available);
  }

  /** Build a sensible profile for a model we have no curated entry for. */
  private inferProfile(id: string): ModelProfile {
    const lower = id.toLowerCase();
    const isCoder = /coder|code|deepseek|starcoder|codestral/.test(lower);
    const isEmbed = /embed|bge|minilm/.test(lower);
    const strengths: TaskKind[] = isEmbed
      ? ['embedding']
      : isCoder
        ? ['code-generation', 'bug-fixing', 'test-generation', 'code-review']
        : ['chat', 'code-explanation', 'planning'];
    const sizeMatch = lower.match(/(\d+(?:\.\d+)?)b/);
    const billions = sizeMatch ? parseFloat(sizeMatch[1]) : 7;
    return {
      id,
      name: id,
      family: id.split(/[:/]/)[0],
      contextWindow: 8192,
      strengths,
      speed: billions <= 8 ? 4 : billions <= 15 ? 3 : 2,
      quality: billions <= 4 ? 2 : billions <= 8 ? 3 : 4,
      available: true,
    };
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  /** Analyze the task, score every candidate, return the winner. */
  route(task: TaskRequest): RoutedModel {
    const kind = task.kind ?? this.inferKind(task.description ?? '');
    const { primaryModel, fallbackModel } = this.config();
    const candidates = this.models.filter((m) => m.available && !m.strengths.includes('embedding'));

    if (candidates.length === 0) {
      // Nothing detected (yet): honor the user's configured preference so the
      // request still goes somewhere sensible once the server comes up.
      const configured =
        this.registry.get(primaryModel) ??
        this.registry.get(fallbackModel) ??
        this.inferProfile(primaryModel);
      return { model: configured, kind, reason: 'no detected models; using configured primary' };
    }

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = this.scoreModel(candidate, kind, task.sizeHint ?? 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    // Respect explicit user preference on ties within one point.
    const preferred = candidates.find((c) => c.id === primaryModel);
    if (preferred) {
      const preferredScore = this.scoreModel(preferred, kind, task.sizeHint ?? 0);
      if (preferredScore >= bestScore - 1) {
        best = preferred;
        bestScore = preferredScore;
      }
    }
    return {
      model: best,
      kind,
      reason: `scored ${bestScore.toFixed(1)} for ${kind}`,
    };
  }

  /** Capability match + quality + speed + observed performance. */
  scoreModel(model: ModelProfile, kind: TaskKind, sizeHint: number): number {
    let score = model.quality * 2;
    if (model.strengths.includes(kind)) {
      score += 6;
    }
    if (kind === 'chat') {
      score += model.speed; // conversation favors latency
    } else {
      score += model.speed * 0.5;
    }
    if (sizeHint > 0 && sizeHint * 0.3 > model.contextWindow) {
      score -= 8; // prompt likely will not fit
    }
    const history = this.metrics.get(model.id) ?? [];
    if (history.length > 0) {
      const successRate = history.filter((m) => m.success).length / history.length;
      const meanTps =
        history.reduce((sum, m) => sum + m.tokensPerSecond, 0) / history.length;
      score += (successRate - 0.5) * 6; // reward reliability, punish flakiness
      score += Math.min(meanTps / 20, 2);
    }
    return score;
  }

  /** Rolling per-model performance window feeding scoreModel(). */
  recordPerformance(metrics: GenerationMetrics): void {
    const history = this.metrics.get(metrics.modelId) ?? [];
    history.push(metrics);
    if (history.length > 50) {
      history.shift();
    }
    this.metrics.set(metrics.modelId, history);
  }

  performanceSnapshot(): Record<string, { runs: number; successRate: number }> {
    const snapshot: Record<string, { runs: number; successRate: number }> = {};
    for (const [id, history] of this.metrics) {
      snapshot[id] = {
        runs: history.length,
        successRate:
          history.length === 0 ? 0 : history.filter((m) => m.success).length / history.length,
      };
    }
    return snapshot;
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  /** Streaming chat completion against the local server. */
  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    // Re-detect occasionally so a freshly started Ollama is picked up.
    if (Date.now() - this.lastDetection > 60_000) {
      await this.detectAvailableModels();
    }
    const kind = options.taskKind ?? 'chat';
    const sizeHint = messages.reduce((sum, m) => sum + m.content.length, 0);
    const routed = this.route({ kind, sizeHint });
    options.onRouted?.(routed.model);
    const { provider, endpoint } = this.config();
    const started = Date.now();
    let text = '';
    let tokens = 0;

    try {
      if (provider === 'ollama') {
        const response = await fetch(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: routed.model.id, messages, stream: true }),
          signal: options.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        // Ollama streams NDJSON: one {"message":{"content":"…"}} object per line.
        for await (const line of ndjsonLines(response.body)) {
          const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string };
          // A mid-stream error arrives on the already-200 body — surface it,
          // otherwise a truncated reply is recorded as a success.
          if (chunk.error) {
            throw new Error(chunk.error);
          }
          const token = chunk.message?.content ?? '';
          if (token.length > 0) {
            text += token;
            tokens += 1;
            options.onToken?.(token);
          }
        }
      } else {
        const response = await fetch(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: routed.model.id, messages, stream: true }),
          signal: options.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }
        // OpenAI wire format: SSE lines "data: {json}" ending with "data: [DONE]".
        for await (const line of ndjsonLines(response.body)) {
          // ":" comment lines are SSE keepalives (legal per the spec, emitted
          // by some LM Studio / proxy setups) — skip, don't parse.
          if (line.startsWith(':')) {
            continue;
          }
          const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
          if (payload === '' || payload === '[DONE]') {
            continue;
          }
          const parsed = parseSseChunk(payload);
          if (!parsed) {
            continue; // a single unparseable frame must not sink a good stream
          }
          if (parsed.error) {
            throw new Error(typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? 'stream error');
          }
          const token = parsed.choices?.[0]?.delta?.content ?? '';
          if (token.length > 0) {
            // Some servers (raw mlx-lm) leak the chat-template stop marker as
            // literal text — cut there and treat the reply as complete.
            const { text: clean, stop } = splitAtStopMarker(token);
            if (clean.length > 0) {
              text += clean;
              tokens += 1;
              options.onToken?.(clean);
            }
            if (stop) {
              break;
            }
          }
        }
      }
      this.recordPerformance({
        modelId: routed.model.id,
        taskKind: kind,
        latencyMs: Date.now() - started,
        tokensPerSecond: tokens / Math.max((Date.now() - started) / 1000, 0.001),
        success: true,
      });
      return text;
    } catch (error) {
      // A user-initiated stop says nothing about the model — only genuine
      // failures may lower its routing score.
      if (!options.signal?.aborted) {
        this.recordPerformance({
          modelId: routed.model.id,
          taskKind: kind,
          latencyMs: Date.now() - started,
          tokensPerSecond: 0,
          success: false,
        });
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Single-prompt convenience over chat(). */
  async generate(prompt: string, options: ChatOptions = {}): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }], options);
  }

  /** Embedding vector, or undefined when no embedding path is available. */
  async embed(text: string): Promise<number[] | undefined> {
    const { provider, endpoint, embeddingModel } = this.config();
    try {
      if (provider === 'ollama') {
        const response = await fetch(`${endpoint}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embeddingModel, prompt: text.slice(0, 8000) }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          return undefined;
        }
        const data = (await response.json()) as { embedding?: number[] };
        return data.embedding && data.embedding.length > 0 ? data.embedding : undefined;
      }
      const response = await fetch(`${endpoint}/v1/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: text.slice(0, 8000) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as { data?: { embedding: number[] }[] };
      return data.data?.[0]?.embedding;
    } catch {
      return undefined;
    }
  }

  /** Classify a natural-language request into a TaskKind. */
  inferKind(description: string): TaskKind {
    for (const [kind, pattern] of KIND_SIGNALS) {
      if (pattern.test(description)) {
        return kind;
      }
    }
    return 'chat';
  }

  private config(): {
    provider: string;
    endpoint: string;
    primaryModel: string;
    fallbackModel: string;
    embeddingModel: string;
  } {
    const config = vscode.workspace.getConfiguration('luigi');
    return {
      provider: config.get<string>('model.provider', 'ollama'),
      endpoint: config.get<string>('model.endpoint', 'http://localhost:11434').replace(/\/$/, ''),
      primaryModel: config.get<string>('model.primaryModel', 'deepseek-coder:6.7b'),
      fallbackModel: config.get<string>('model.fallbackModel', 'codellama:13b'),
      embeddingModel: config.get<string>('model.embeddingModel', 'nomic-embed-text'),
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
