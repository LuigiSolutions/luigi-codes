/**
 * Luigi Codes — self-improvement subsystem.
 *
 * Three loops, from immediate to long-horizon:
 *   1. analyzeTask()          — classify every run; failure categories accumulate
 *   2. optimizePrompts()      — recurring failures become standing rules that are
 *                               injected into future planning prompts (promptGuidance)
 *   3. shouldFineTune()       — when enough accepted interactions + corrections
 *                               exist, Luigi reports that a fine-tuning dataset is
 *                               ready (training itself stays a deliberate human step)
 *
 * Everything persists to the extension's global storage as JSON — inspectable,
 * portable, deletable. No telemetry, no cloud: improvement data is yours.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { TaskRecord } from '../memory/memorySystem';

type Logger = (message: string) => void;

export interface InteractionSample {
  kind: 'agent-task' | 'chat' | 'edit';
  prompt: string;
  response: string;
  accepted: boolean;
  timestamp: number;
}

export interface CorrectionSample {
  original: string;
  corrected: string;
  context: string;
  pattern: string;
  timestamp: number;
}

export interface TaskAnalysis {
  taskId: string;
  success: boolean;
  failureCategory?: FailureCategory;
  lessons: string[];
}

export interface PromptAdjustment {
  rule: string;
  reason: string;
  addedAt: number;
}

export interface FineTuneReadiness {
  ready: boolean;
  reason: string;
  datasetSize: number;
}

type FailureCategory =
  | 'model-unreachable'
  | 'plan-not-parseable'
  | 'plan-rejected'
  | 'tool-failure'
  | 'unknown';

interface ImprovementState {
  interactions: InteractionSample[];
  corrections: CorrectionSample[];
  failureCounts: Partial<Record<FailureCategory, number>>;
  adjustments: PromptAdjustment[];
}

const MAX_INTERACTIONS = 1000;
const MAX_CORRECTIONS = 300;
const ADJUSTMENT_THRESHOLD = 3; // same failure 3× → standing rule
const FINE_TUNE_MIN_SAMPLES = 100;
const FINE_TUNE_MIN_ACCEPTANCE = 0.6;
/** Pending Luigi-authored files awaiting a possible human edit. */
const MAX_PENDING_FILES = 100;
/** A save this long after Luigi wrote a file is no longer attributable to it. */
const CORRECTION_TTL_MS = 60 * 60 * 1000; // 1 hour

interface ProducedFile {
  content: string;
  context: string;
  timestamp: number;
}

/** Failure category → the standing rule that counters it. */
/** Keep the first occurrence of each rule (persisted rules win over re-derived ones). */
function dedupeAdjustments(adjustments: PromptAdjustment[]): PromptAdjustment[] {
  const seen = new Set<string>();
  const out: PromptAdjustment[] = [];
  for (const a of adjustments) {
    if (!seen.has(a.rule)) {
      seen.add(a.rule);
      out.push(a);
    }
  }
  return out;
}

const CATEGORY_RULES: Record<FailureCategory, PromptAdjustment['rule']> = {
  'plan-not-parseable':
    'Output ONLY the JSON array, no prose before or after it, no markdown fences.',
  'tool-failure':
    'Before editing or deleting a file, verify it exists first (grep or readFile).',
  'plan-rejected':
    'Prefer fewer, smaller, more conservative steps; avoid destructive operations unless asked.',
  'model-unreachable': 'Keep plans short and resumable; the local server may drop mid-run.',
  unknown: 'State assumptions explicitly in step descriptions.',
};

export class SelfImprovement {
  private state: ImprovementState = {
    interactions: [],
    corrections: [],
    failureCounts: {},
    adjustments: [],
  };
  /**
   * Files Luigi just wrote, keyed by workspace-relative path — an in-memory,
   * session-scoped baseline (never persisted) used to notice a later human
   * edit of Luigi's output and capture it as a training correction.
   */
  private readonly producedFiles = new Map<string, ProducedFile>();
  private initPromise: Promise<void> | undefined;

  constructor(
    private readonly storageUri: vscode.Uri,
    private readonly log: Logger
  ) {}

  /** Single-flight: every caller awaits the same load, however early it asks. */
  initialize(): Promise<void> {
    this.initPromise ??= this.loadState();
    return this.initPromise;
  }

  private async loadState(): Promise<void> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ImprovementState>;
      // Merge persisted state UNDER anything captured before initialization
      // finished — a capture racing the load must never be clobbered.
      const current = this.state;
      this.state = {
        interactions: [
          ...(Array.isArray(parsed.interactions) ? parsed.interactions : []),
          ...current.interactions,
        ],
        corrections: [
          ...(Array.isArray(parsed.corrections) ? parsed.corrections : []),
          ...current.corrections,
        ],
        failureCounts: { ...(parsed.failureCounts ?? {}) },
        // Merge like the other fields: a rule learned before load finished must
        // not be dropped. De-dupe by rule text, persisted first.
        adjustments: dedupeAdjustments([
          ...(Array.isArray(parsed.adjustments) ? parsed.adjustments : []),
          ...current.adjustments,
        ]),
      };
      for (const [category, count] of Object.entries(current.failureCounts) as [
        FailureCategory,
        number,
      ][]) {
        this.state.failureCounts[category] = (this.state.failureCounts[category] ?? 0) + count;
      }
      this.log(
        `Self-improvement: ${this.state.interactions.length} interaction(s), ` +
          `${this.state.adjustments.length} learned rule(s).`
      );
    } catch {
      // first run — empty state is the correct state
    }
  }

  // ── Loop 1: per-task analysis ──────────────────────────────────────────────

  /** Classify a finished run and record what it teaches. */
  analyzeTask(record: TaskRecord): TaskAnalysis {
    const lessons: string[] = [];
    let failureCategory: FailureCategory | undefined;

    if (record.success) {
      if (record.durationMs > 120_000) {
        lessons.push('Slow success; consider smaller plans for similar prompts.');
      }
      if (record.filesTouched.length > 0) {
        lessons.push(`Touched ${record.filesTouched.length} file(s) successfully.`);
      }
    } else {
      failureCategory = this.categorize(record.outcome);
      this.state.failureCounts[failureCategory] =
        (this.state.failureCounts[failureCategory] ?? 0) + 1;
      lessons.push(`Failure category: ${failureCategory}.`);
      // Recurring pain becomes a standing rule immediately.
      const added = this.optimizePrompts();
      if (added.length > 0) {
        lessons.push(`New standing rule: ${added[added.length - 1].rule}`);
      }
    }
    void this.save();
    return { taskId: record.id, success: record.success, failureCategory, lessons };
  }

  private categorize(outcome: string): FailureCategory {
    if (/unreachable|ECONNREFUSED|fetch failed|HTTP 5\d\d|timeout/i.test(outcome)) {
      return 'model-unreachable';
    }
    if (/could not derive an actionable plan|not parseable/i.test(outcome)) {
      return 'plan-not-parseable';
    }
    if (/rejected/i.test(outcome)) {
      return 'plan-rejected';
    }
    if (/step.*failed|tool|ENOENT|no such file/i.test(outcome)) {
      return 'tool-failure';
    }
    return 'unknown';
  }

  // ── Loop 2: dataset capture ────────────────────────────────────────────────

  /** Every meaningful exchange is a potential future training pair. */
  captureInteraction(interaction: InteractionSample): void {
    this.state.interactions.push(interaction);
    if (this.state.interactions.length > MAX_INTERACTIONS) {
      this.state.interactions = this.state.interactions.slice(-MAX_INTERACTIONS);
    }
    void this.save();
  }

  /**
   * The strongest learning signal there is: the user took Luigi's output and
   * changed it. Store the pair and a coarse description of what changed.
   */
  learnFromCorrections(original: string, corrected: string, context: string): void {
    const pattern = describeCorrection(original, corrected);
    this.state.corrections.push({
      original: original.slice(0, 4000),
      corrected: corrected.slice(0, 4000),
      context: context.slice(0, 400),
      pattern,
      timestamp: Date.now(),
    });
    if (this.state.corrections.length > MAX_CORRECTIONS) {
      this.state.corrections = this.state.corrections.slice(-MAX_CORRECTIONS);
    }
    this.log(`Correction learned: ${pattern}`);
    void this.save();
  }

  /**
   * Record a file Luigi just authored, as the baseline for a future
   * correction. Call this right after a successful agent file write.
   */
  noteProducedFile(path: string, content: string, context: string): void {
    // Delete-then-set so re-writing a file moves it to the most-recent
    // position; otherwise Map keeps its original slot and it could be evicted
    // before newer single-write files.
    this.producedFiles.delete(path);
    this.producedFiles.set(path, { content, context, timestamp: Date.now() });
    // Bound the map; drop the oldest entries first (insertion order).
    while (this.producedFiles.size > MAX_PENDING_FILES) {
      const oldest = this.producedFiles.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.producedFiles.delete(oldest);
    }
  }

  /**
   * A workspace file was saved. If Luigi authored it recently and the human
   * changed it, capture the pair as a correction. Consumes the baseline so a
   * single edit is learned once. Returns true if a correction was captured.
   */
  reconcileSavedFile(path: string, savedContent: string): boolean {
    const produced = this.producedFiles.get(path);
    if (!produced) {
      return false;
    }
    // Attribution weakens over time — an edit an hour later is the user's own
    // ongoing work, not a correction of Luigi's output.
    if (Date.now() - produced.timestamp > CORRECTION_TTL_MS) {
      this.producedFiles.delete(path);
      return false;
    }
    if (savedContent === produced.content) {
      // Saved unchanged (e.g. format-on-save no-op) — keep the baseline; the
      // real edit may still be coming.
      return false;
    }
    this.producedFiles.delete(path);
    this.learnFromCorrections(produced.content, savedContent, `${produced.context} (file: ${path})`);
    return true;
  }

  // ── Loop 2b: prompt optimization ───────────────────────────────────────────

  /**
   * Turn recurring failure categories into standing rules. Idempotent —
   * returns only the adjustments added by this call.
   */
  optimizePrompts(): PromptAdjustment[] {
    const added: PromptAdjustment[] = [];
    for (const [category, count] of Object.entries(this.state.failureCounts) as [
      FailureCategory,
      number,
    ][]) {
      if (count >= ADJUSTMENT_THRESHOLD) {
        const rule = CATEGORY_RULES[category];
        if (!this.state.adjustments.some((a) => a.rule === rule)) {
          const adjustment: PromptAdjustment = {
            rule,
            reason: `${category} occurred ${count}×`,
            addedAt: Date.now(),
          };
          this.state.adjustments.push(adjustment);
          added.push(adjustment);
          this.log(`Prompt optimized: +"${rule}" (${adjustment.reason})`);
        }
      }
    }
    if (added.length > 0) {
      void this.save();
    }
    return added;
  }

  /** Learned rules, formatted for injection into the planning prompt. */
  promptGuidance(): string {
    if (this.state.adjustments.length === 0) {
      return '';
    }
    const rules = this.state.adjustments
      .slice(-4)
      .map((a) => `- ${a.rule}`)
      .join('\n');
    return `LEARNED GUIDANCE (from past runs on this machine):\n${rules}\n`;
  }

  // ── Loop 3: fine-tune readiness ────────────────────────────────────────────

  /**
   * Is there enough high-quality local data to fine-tune a personal model?
   * Luigi reports readiness; kicking off training stays a human decision.
   */
  shouldFineTune(): FineTuneReadiness {
    const accepted = this.state.interactions.filter((i) => i.accepted).length;
    const datasetSize = accepted + this.state.corrections.length;
    if (datasetSize < FINE_TUNE_MIN_SAMPLES) {
      return {
        ready: false,
        reason: `collecting data (${datasetSize}/${FINE_TUNE_MIN_SAMPLES} samples)`,
        datasetSize,
      };
    }
    const acceptance =
      this.state.interactions.length === 0
        ? 0
        : accepted / this.state.interactions.length;
    if (acceptance < FINE_TUNE_MIN_ACCEPTANCE) {
      return {
        ready: false,
        reason: `acceptance rate ${(acceptance * 100).toFixed(0)}%, below ${FINE_TUNE_MIN_ACCEPTANCE * 100}%`,
        datasetSize,
      };
    }
    return {
      ready: true,
      reason: `${datasetSize} quality samples at ${(acceptance * 100).toFixed(0)}% acceptance`,
      datasetSize,
    };
  }

  // ── Loop 3b: fine-tune export ──────────────────────────────────────────────

  /**
   * Turn the collected local signals into chat-format training examples:
   *   - accepted interactions → (prompt → the accepted response)
   *   - corrections           → (context → the human-corrected version)
   * The corrected text is the gold target; Luigi's rejected original is never
   * used as a label. Nothing here leaves the machine.
   */
  buildTrainingExamples(): TrainingExample[] {
    return buildTrainingExamples(this.state.interactions, this.state.corrections);
  }

  /**
   * Export the dataset as MLX/OpenAI chat JSONL, deterministically split into
   * train/valid (every Nth example to validation). Returns the split so the
   * caller can write the files and report counts.
   */
  exportTrainingJsonl(validEvery = 10): { train: string; valid: string; count: number } {
    const examples = this.buildTrainingExamples();
    const train: string[] = [];
    const valid: string[] = [];
    examples.forEach((example, i) => {
      const line = JSON.stringify(example);
      (validEvery > 0 && i % validEvery === validEvery - 1 ? valid : train).push(line);
    });
    // Never hand back an empty validation set when there is data to train on —
    // mlx_lm requires a non-empty valid.jsonl.
    if (valid.length === 0 && train.length > 1) {
      valid.push(train.pop() as string);
    }
    return { train: train.join('\n'), valid: valid.join('\n'), count: examples.length };
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  private get stateFile(): string {
    return path.join(this.storageUri.fsPath, 'improvement.json');
  }

  private writeChain: Promise<void> = Promise.resolve();

  private async save(): Promise<void> {
    // Serialize writes so two concurrent (often un-awaited) saves never
    // interleave into the same file, and write atomically so a crash mid-write
    // can't truncate improvement.json into unparseable JSON (which loadState
    // would then silently discard, losing every learned rule and correction).
    this.writeChain = this.writeChain.then(() => this.writeState());
    return this.writeChain;
  }

  private async writeState(): Promise<void> {
    try {
      // Load-before-write: saving prior to initialization would overwrite the
      // persisted history with a near-empty state.
      await this.initialize();
      await fs.mkdir(this.storageUri.fsPath, { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.state), 'utf8');
      await fs.rename(tmp, this.stateFile);
    } catch (error) {
      this.log(
        `Self-improvement: save failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** One chat-format training row (MLX / OpenAI `messages` schema). */
export interface TrainingExample {
  messages: { role: 'user' | 'assistant'; content: string }[];
}

/**
 * Build chat training pairs from collected signals. Pure and exported so the
 * export format is unit-testable without touching disk. Empty-content pairs are
 * skipped; the corrected text (not the rejected original) is always the label.
 */
export function buildTrainingExamples(
  interactions: InteractionSample[],
  corrections: CorrectionSample[]
): TrainingExample[] {
  const examples: TrainingExample[] = [];
  for (const interaction of interactions) {
    if (interaction.accepted && interaction.prompt.trim() && interaction.response.trim()) {
      examples.push({
        messages: [
          { role: 'user', content: interaction.prompt },
          { role: 'assistant', content: interaction.response },
        ],
      });
    }
  }
  for (const correction of corrections) {
    const request = correction.context.trim() || correction.original.trim();
    if (request && correction.corrected.trim()) {
      examples.push({
        messages: [
          { role: 'user', content: request },
          { role: 'assistant', content: correction.corrected },
        ],
      });
    }
  }
  return examples;
}

/** Coarse, honest description of what a human changed in Luigi's output. */
function describeCorrection(original: string, corrected: string): string {
  const signals: string[] = [];
  const delta = corrected.length - original.length;
  if (Math.abs(delta) > original.length * 0.5) {
    signals.push(delta > 0 ? 'substantially expanded' : 'substantially shortened');
  }
  const addedErrorHandling =
    /try\s*\{|catch|except|Result<|\.catch\(/.test(corrected) &&
    !/try\s*\{|catch|except|Result<|\.catch\(/.test(original);
  if (addedErrorHandling) {
    signals.push('added error handling');
  }
  const addedTypes =
    /: [A-Z]\w+|interface |type \w+ =/.test(corrected) &&
    !/: [A-Z]\w+|interface |type \w+ =/.test(original);
  if (addedTypes) {
    signals.push('added type annotations');
  }
  if (signals.length === 0) {
    signals.push('stylistic revision');
  }
  return signals.join(', ');
}
