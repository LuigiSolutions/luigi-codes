/**
 * Luigi Codes — the agent loop.
 *
 * Five phases, every run:
 *   1. context  — pull relevant files, symbols, and similar past tasks
 *   2. plan     — the model writes a step-by-step tool plan (JSON)
 *   3. approve  — the human sees the plan in a modal before anything runs
 *   4. execute  — steps run through the tool registry with self-correction
 *   5. verify   — the model reviews the transcript and reports honestly
 *
 * Every run then feeds memory + self-improvement, so the next plan is better.
 */
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { CodebaseIndex } from '../context/codebaseIndex';
import { SelfImprovement } from '../improvement/selfImprove';
import { ModelRouter, TaskKind } from '../inference/modelRouter';
import { MemorySystem, TaskRecord } from '../memory/memorySystem';
import { ToolRegistry } from './tools/toolRegistry';

type Logger = (message: string) => void;

export type AgentPhase = 'context' | 'plan' | 'approve' | 'execute' | 'verify' | 'done';

export interface AgentProgressEvent {
  phase: AgentPhase;
  message: string;
  level?: 'info' | 'success' | 'error';
  step?: number;
  totalSteps?: number;
}

export interface AgentTask {
  prompt: string;
  kind?: TaskKind;
}

export interface PlanStep {
  id: number;
  description: string;
  /** Registered tool name, or undefined for a pure reasoning step. */
  tool?: string;
  args?: Record<string, string>;
}

export interface StepOutcome {
  step: PlanStep;
  ok: boolean;
  output: string;
  attempts: number;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  outcomes: StepOutcome[];
  durationMs: number;
}

export interface GatheredContext {
  relevantFiles: { path: string; symbols: string[] }[];
  priorTasks: string[];
  patternSummary: string;
}

interface FixStrategy {
  action: 'retry' | 'repair' | 'skip';
  note: string;
}

export class LuigiAgent implements vscode.Disposable {
  private readonly progress = new vscode.EventEmitter<AgentProgressEvent>();
  readonly onProgress: vscode.Event<AgentProgressEvent> = this.progress.event;
  private running = false;
  /** Cancellation for the single in-flight run; set by execute(). */
  private signal: AbortSignal | undefined;

  constructor(
    private readonly router: ModelRouter,
    private readonly tools: ToolRegistry,
    private readonly index: CodebaseIndex,
    private readonly memory: MemorySystem,
    private readonly improve: SelfImprovement,
    private readonly log: Logger
  ) {}

  dispose(): void {
    this.progress.dispose();
  }

  /** The full 5-phase loop. Exactly one run at a time. */
  async execute(task: AgentTask, signal?: AbortSignal): Promise<AgentResult> {
    if (this.running) {
      return {
        success: false,
        summary: 'An agent run is already in progress.',
        outcomes: [],
        durationMs: 0,
      };
    }
    this.running = true;
    this.signal = signal;
    const started = Date.now();
    try {
      // Phase 1 — context
      this.emit('context', 'Gathering workspace context…');
      const context = await this.gatherContext(task);
      this.emit(
        'context',
        `${context.relevantFiles.length} relevant file(s), ${context.priorTasks.length} similar past task(s).`,
        'success'
      );

      // Phase 2 — plan
      this.emit('plan', 'Drafting a plan…');
      const plan = await this.createPlan(task, context);
      if (plan.length === 0) {
        const summary = 'Could not derive an actionable plan from the model response.';
        this.emit('plan', summary, 'error');
        return this.finish(task, [], false, summary, started);
      }
      for (const step of plan) {
        this.emit('plan', `Step ${step.id}: ${step.description}${step.tool ? ` [${step.tool}]` : ''}`);
      }

      // Phase 3 — approve
      this.emit('approve', 'Waiting for approval…');
      const approved = await this.requestApproval(plan);
      if (!approved) {
        this.emit('approve', 'Plan rejected by user.', 'error');
        return this.finish(task, [], false, 'Plan rejected; nothing was executed.', started);
      }
      this.emit('approve', 'Plan approved.', 'success');

      // Phase 4 — execute (with self-correction)
      const outcomes: StepOutcome[] = [];
      for (const step of plan) {
        if (signal?.aborted) {
          this.emit('execute', 'Stopped by user; remaining steps skipped.', 'error');
          return this.finish(
            task,
            outcomes,
            false,
            `Stopped by user after ${outcomes.length}/${plan.length} step(s).`,
            started
          );
        }
        this.emit('execute', `Step ${step.id}/${plan.length}: ${step.description}`, 'info', step.id, plan.length);
        const outcome = await this.executeStep(step, outcomes, task);
        outcomes.push(outcome);
        this.emit(
          'execute',
          `Step ${step.id} ${outcome.ok ? 'succeeded' : 'failed'} (${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}).`,
          outcome.ok ? 'success' : 'error'
        );
      }

      // Phase 5 — verify
      this.emit('verify', 'Reviewing results…');
      const failed = outcomes.filter((o) => !o.ok);
      const summary = await this.verify(task, outcomes);
      const success = failed.length === 0;
      this.emit('verify', success ? 'All steps verified.' : `${failed.length} step(s) failed.`, success ? 'success' : 'error');

      return this.finish(task, outcomes, success, summary, started);
    } catch (error) {
      if (signal?.aborted) {
        return this.finish(task, [], false, 'Stopped by user.', started);
      }
      throw error;
    } finally {
      this.running = false;
      this.signal = undefined;
      this.emit('done', 'Agent run complete.');
    }
  }

  // ── Phase 1 ────────────────────────────────────────────────────────────────

  async gatherContext(task: AgentTask): Promise<GatheredContext> {
    const [files, prior] = await Promise.all([
      this.index.findRelevantFiles(task.prompt, 5),
      this.memory.findSimilar(task.prompt, 3),
    ]);
    return {
      relevantFiles: files.map((f) => ({
        path: f.path,
        symbols: f.symbols.slice(0, 12).map((s) => `${s.kind} ${s.name}`),
      })),
      priorTasks: prior.map(
        (t) => `"${t.prompt.slice(0, 90)}" → ${t.success ? 'succeeded' : 'failed'}: ${t.outcome.slice(0, 120)}`
      ),
      patternSummary: this.index.extractPatterns().summary,
    };
  }

  // ── Phase 2 ────────────────────────────────────────────────────────────────

  async createPlan(task: AgentTask, context: GatheredContext): Promise<PlanStep[]> {
    const raw = await this.callModel(this.buildPlanningPrompt(task, context), 'planning');
    const steps = this.parsePlanFromResponse(raw);
    // Unknown tool names become reasoning steps instead of guaranteed failures.
    for (const step of steps) {
      if (step.tool && !this.tools.has(step.tool)) {
        this.log(`Plan referenced unknown tool "${step.tool}"; demoted to reasoning step.`);
        step.description = `${step.description} (wanted unavailable tool: ${step.tool})`;
        step.tool = undefined;
      }
    }
    return steps.slice(0, 12); // hard cap: no runaway plans
  }

  buildPlanningPrompt(task: AgentTask, context: GatheredContext): string {
    const fileLines = context.relevantFiles
      .map((f) => `- ${f.path}: ${f.symbols.join(', ') || 'no symbols parsed'}`)
      .join('\n');
    const guidance = this.improve.promptGuidance();
    return [
      'You are Luigi, a careful local coding agent. Produce a SHORT executable plan for the task below.',
      '',
      `TASK: ${task.prompt}`,
      '',
      'WORKSPACE CONTEXT:',
      context.patternSummary,
      fileLines || '- (no indexed files matched)',
      '',
      context.priorTasks.length > 0 ? `SIMILAR PAST TASKS:\n${context.priorTasks.join('\n')}\n` : '',
      'AVAILABLE TOOLS:',
      this.tools.describeForPrompt(),
      '',
      guidance,
      'Respond with ONLY a JSON array. Each element: {"description": string, "tool": string (optional), "args": object of string values (optional)}.',
      'Use at most 8 steps. Use a tool step whenever the task touches files, shell, git, or tests.',
      'For a step that only synthesizes or explains, omit "tool".',
    ]
      .filter((part) => part.length > 0)
      .join('\n');
  }

  parsePlanFromResponse(raw: string): PlanStep[] {
    // Preferred: a JSON array, possibly inside a fenced block or surrounded by prose.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidates: string[] = [];
    if (fenced) {
      candidates.push(fenced[1]);
    }
    const bracket = raw.match(/\[[\s\S]*\]/);
    if (bracket) {
      candidates.push(bracket[0]);
    }
    for (const candidate of candidates) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (Array.isArray(parsed)) {
          const steps: PlanStep[] = [];
          for (const item of parsed) {
            if (item && typeof item === 'object' && typeof (item as { description?: unknown }).description === 'string') {
              const record = item as { description: string; tool?: unknown; args?: unknown };
              steps.push({
                id: steps.length + 1,
                description: record.description,
                tool: typeof record.tool === 'string' && record.tool.length > 0 ? record.tool : undefined,
                args: normalizeArgs(record.args),
              });
            }
          }
          if (steps.length > 0) {
            return steps;
          }
        }
      } catch {
        // fall through to the next candidate
      }
    }
    // Fallback: numbered/bulleted prose becomes reasoning steps.
    const lines = raw
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s+/, '').trim())
      .filter((line, index, all) => line.length > 8 && all.indexOf(line) === index);
    return lines.slice(0, 6).map((description, i) => ({ id: i + 1, description }));
  }

  // ── Phase 3 ────────────────────────────────────────────────────────────────

  /** Modal approval — the human gate before any tool touches the machine. */
  async requestApproval(plan: PlanStep[]): Promise<boolean> {
    // autoApprove only ever waives the modal for read-only plans; any step
    // whose tool mutates the machine (requiresApproval) always asks a human.
    const autoApprove = vscode.workspace.getConfiguration('luigi').get<boolean>('agent.autoApprove', false);
    const mutating = plan.some(
      (step) => step.tool !== undefined && (this.tools.get(step.tool)?.requiresApproval ?? true)
    );
    if (autoApprove && !mutating) {
      return true;
    }
    // Show the actual arguments a mutating step will run with — approving a
    // shell command or file write means seeing the command/content, not just
    // a description the model wrote.
    const detail = plan
      .map((step) => {
        const head = `${step.id}. ${step.description}${step.tool ? `  [${step.tool}]` : ''}`;
        if (step.tool && step.args && Object.keys(step.args).length > 0) {
          const argText = Object.entries(step.args)
            .map(([key, value]) => `      ${key}: ${value.length > 300 ? `${value.slice(0, 300)}…` : value}`)
            .join('\n');
          return `${head}\n${argText}`;
        }
        return head;
      })
      .join('\n');
    const choice = await vscode.window.showWarningMessage(
      `🍄 Luigi Agent wants to run ${plan.length} step${plan.length === 1 ? '' : 's'}`,
      { modal: true, detail },
      'Approve & Run'
    );
    return choice === 'Approve & Run';
  }

  // ── Phase 4 ────────────────────────────────────────────────────────────────

  private async executeStep(step: PlanStep, previous: StepOutcome[], task: AgentTask): Promise<StepOutcome> {
    const maxRetries = Math.max(1, vscode.workspace.getConfiguration('luigi').get<number>('agent.maxRetries', 3));

    if (!step.tool) {
      // Reasoning step: the model works over the transcript so far.
      try {
        const transcript = previous
          .map((o) => `Step ${o.step.id} (${o.step.description}):\n${o.output.slice(0, 1500)}`)
          .join('\n\n');
        const output = await this.callModel(
          `TASK: ${task.prompt}\n\nRESULTS SO FAR:\n${transcript || '(none)'}\n\nNow do this step and reply with the result only:\n${step.description}`,
          'code-generation'
        );
        return { step, ok: true, output, attempts: 1 };
      } catch (error) {
        return { step, ok: false, output: describe(error), attempts: 1 };
      }
    }

    let args = step.args ?? {};
    let lastError = '';
    let attempt = 1;
    for (; attempt <= maxRetries; attempt++) {
      if (this.signal?.aborted) {
        return { step, ok: false, output: 'Stopped by user.', attempts: attempt };
      }
      const result = await this.tools.execute(step.tool, args);
      if (result.ok) {
        // Baseline for correction learning: Luigi wrote a complete file; if a
        // human later edits and saves it, that diff becomes a training pair.
        if (step.tool === 'writeFile' && typeof args.path === 'string' && typeof args.content === 'string') {
          this.improve.noteProducedFile(args.path, args.content, task.prompt);
        }
        return { step, ok: true, output: result.output, attempts: attempt };
      }
      lastError = result.error ?? result.output;
      const strategy = this.getFixStrategy(step, lastError, attempt, maxRetries);
      this.emit('execute', `Step ${step.id} attempt ${attempt} failed: ${strategy.note}`, 'error');
      if (strategy.action === 'skip') {
        break;
      }
      if (strategy.action === 'repair') {
        const repaired = await this.repairArgs(step, args, lastError);
        if (repaired) {
          args = repaired;
        }
      }
    }
    // Report the attempts actually made — a step skipped early (e.g. a mutating
    // tool that won't repair) must not claim it used every retry.
    return { step, ok: false, output: lastError, attempts: Math.min(attempt, maxRetries) };
  }

  /**
   * Self-correction policy: transient retry first, model-guided argument
   * repair second, then a clean skip so one bad step can't wedge the run.
   */
  getFixStrategy(step: PlanStep, error: string, attempt: number, maxRetries: number): FixStrategy {
    if (attempt >= maxRetries) {
      return { action: 'skip', note: 'retries exhausted, moving on' };
    }
    // Argument repair rewrites what runs. For a tool the human approved by its
    // exact arguments (mutating tools), silently running model-invented args
    // would break the approval contract — retry as-approved, never repair.
    const mutating = step.tool !== undefined && (this.tools.get(step.tool)?.requiresApproval ?? true);
    if (mutating) {
      return attempt === 1
        ? { action: 'retry', note: 'retrying with the approved arguments' }
        : { action: 'skip', note: 'approved arguments failed; not rewriting them post-approval' };
    }
    const argProblem = /ENOENT|no such file|not found|invalid|missing|required|EACCES/i.test(error);
    if (attempt === 1 && !argProblem) {
      return { action: 'retry', note: 'possibly transient, retrying as-is' };
    }
    return {
      action: 'repair',
      note: `asking the model to repair arguments for ${step.tool ?? 'step'}`,
    };
  }

  private async repairArgs(
    step: PlanStep,
    args: Record<string, string>,
    error: string
  ): Promise<Record<string, string> | undefined> {
    try {
      const raw = await this.callModel(
        [
          `A tool call failed. Tool: ${step.tool}. Goal: ${step.description}`,
          `Arguments used: ${JSON.stringify(args)}`,
          `Error: ${error.slice(0, 500)}`,
          'Reply with ONLY a corrected JSON object of string arguments for the same tool.',
        ].join('\n'),
        'bug-fixing'
      );
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        return undefined;
      }
      return normalizeArgs(JSON.parse(match[0]));
    } catch {
      return undefined;
    }
  }

  // ── Phase 5 ────────────────────────────────────────────────────────────────

  private async verify(task: AgentTask, outcomes: StepOutcome[]): Promise<string> {
    const transcript = outcomes
      .map(
        (o) =>
          `Step ${o.step.id}: ${o.step.description} [${o.ok ? 'OK' : 'FAILED'}]\n${o.output.slice(0, 1200)}`
      )
      .join('\n\n');
    try {
      return await this.callModel(
        `TASK: ${task.prompt}\n\nEXECUTION TRANSCRIPT:\n${transcript}\n\n` +
          'Write a short, honest report for the user: what was accomplished, what failed and why, and the single best next step. Plain prose, no preamble.',
        'code-review'
      );
    } catch {
      // Verification must never sink the run's actual results.
      const done = outcomes.filter((o) => o.ok).length;
      return `${done}/${outcomes.length} steps completed. (Model unavailable for the final report.)`;
    }
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  /** All model calls flow through the router so routing/metrics stay unified. */
  async callModel(prompt: string, kind: TaskKind): Promise<string> {
    return this.router.generate(prompt, { taskKind: kind, signal: this.signal });
  }

  private async finish(
    task: AgentTask,
    outcomes: StepOutcome[],
    success: boolean,
    summary: string,
    started: number
  ): Promise<AgentResult> {
    const result: AgentResult = {
      success,
      summary,
      outcomes,
      durationMs: Date.now() - started,
    };
    try {
      await this.learnFromTask(task, result);
    } catch (error) {
      this.log(`learnFromTask failed (non-fatal): ${describe(error)}`);
    }
    return result;
  }

  /** Close the loop: persist the run and let self-improvement analyze it. */
  async learnFromTask(task: AgentTask, result: AgentResult): Promise<void> {
    const filesTouched = result.outcomes
      .filter((o) => o.step.tool && /file/i.test(o.step.tool))
      .map((o) => o.step.args?.path ?? '')
      .filter((path) => path.length > 0);
    const record: TaskRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      prompt: task.prompt,
      planSummary: result.outcomes.map((o) => o.step.description).join(' → ') || 'no plan executed',
      outcome: result.summary,
      success: result.success,
      filesTouched,
      durationMs: result.durationMs,
    };
    await this.memory.storeTask(record);
    this.improve.captureInteraction({
      kind: 'agent-task',
      prompt: task.prompt,
      response: record.planSummary,
      accepted: result.success,
      timestamp: record.timestamp,
    });
    const analysis = this.improve.analyzeTask(record);
    if (analysis.lessons.length > 0) {
      this.log(`Lessons: ${analysis.lessons.join(' | ')}`);
    }
  }

  private emit(phase: AgentPhase, message: string, level: 'info' | 'success' | 'error' = 'info', step?: number, totalSteps?: number): void {
    this.log(`[agent:${phase}] ${message}`);
    this.progress.fire({ phase, message, level, step, totalSteps });
  }
}

function normalizeArgs(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const args: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    args[key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
  }
  return args;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
