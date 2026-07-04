/**
 * Luigi Codes — tool registry.
 *
 * The agent's hands. Every capability the agent has on the machine is a
 * registered tool with a name, a described parameter contract, and an
 * approval flag. File paths are always workspace-relative and are resolved
 * through a traversal guard so a plan can never reach outside the workspace.
 */
import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

type Logger = (message: string) => void;

const execAsync = promisify(exec);

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
}

export interface LuigiTool {
  name: string;
  description: string;
  /** parameter name → human description; the planner reads this. */
  parameters: Record<string, string>;
  /** Tools that mutate the machine sit behind the plan-approval gate. */
  requiresApproval: boolean;
  run(args: Record<string, string>): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, LuigiTool>();

  constructor(private readonly log: Logger) {}

  register(tool: LuigiTool): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): LuigiTool | undefined {
    return this.tools.get(name);
  }

  list(): LuigiTool[] {
    return [...this.tools.values()];
  }

  /** One line per tool, consumed by the planning prompt. */
  describeForPrompt(): string {
    return this.list()
      .map((tool) => {
        const params = Object.keys(tool.parameters).join(', ');
        return `- ${tool.name}(${params}): ${tool.description}`;
      })
      .join('\n');
  }

  async execute(name: string, args: Record<string, string>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: '', error: `Unknown tool: ${name}` };
    }
    this.log(`Tool ${name}(${JSON.stringify(args).slice(0, 200)})`);
    try {
      return await tool.run(args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, output: '', error: message };
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder.uri.fsPath;
}

/** Resolve a workspace-relative path and refuse anything that escapes it. */
function resolveSafe(relativePath: string): string {
  const root = workspaceRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}

function cap(text: string, limit = 20000): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} chars truncated)`
    : text;
}

async function runShell(command: string, cwd: string, timeoutMs: number): Promise<ToolResult> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = [stdout, stderr].filter((s) => s.trim().length > 0).join('\n');
    return { ok: true, output: cap(output) || '(no output)' };
  } catch (error) {
    // exec rejects on non-zero exit, but stdout/stderr still carry the story
    // (a failing test run is signal, not noise).
    const e = error as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stdout ?? '', e.stderr ?? ''].filter((s) => s.trim().length > 0).join('\n');
    return {
      ok: false,
      output: cap(output),
      error: e.message ?? 'command failed',
    };
  }
}

const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,c,cpp,h,hpp,swift,kt,md,json,yaml,yml,toml,css,html}';
const EXCLUDE_GLOB = '**/{node_modules,out,dist,build,.git,target,vendor,__pycache__,.next}/**';

// ── Default tool set (11 tools) ─────────────────────────────────────────────

export function createDefaultTools(log: Logger): LuigiTool[] {
  return [
    {
      name: 'readFile',
      description: 'Read a file from the workspace.',
      parameters: { path: 'workspace-relative file path' },
      requiresApproval: false,
      async run(args) {
        const target = resolveSafe(required(args, 'path'));
        const content = await fs.readFile(target, 'utf8');
        return { ok: true, output: cap(content, 40000) };
      },
    },
    {
      name: 'writeFile',
      description: 'Create or overwrite a file with the given content.',
      parameters: { path: 'workspace-relative file path', content: 'full file content' },
      requiresApproval: true,
      async run(args) {
        const target = resolveSafe(required(args, 'path'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, args.content ?? '', 'utf8');
        return { ok: true, output: `Wrote ${args.path} (${(args.content ?? '').length} chars).` };
      },
    },
    {
      name: 'editFile',
      description: 'Replace an exact text snippet inside a file (first occurrence).',
      parameters: {
        path: 'workspace-relative file path',
        find: 'exact text to find',
        replace: 'replacement text',
      },
      requiresApproval: true,
      async run(args) {
        const target = resolveSafe(required(args, 'path'));
        const find = required(args, 'find');
        const original = await fs.readFile(target, 'utf8');
        if (!original.includes(find)) {
          return { ok: false, output: '', error: `Text not found in ${args.path}.` };
        }
        const occurrences = original.split(find).length - 1;
        // Replacer function: literal insertion — a plain string here would let
        // $&, $', $` and friends in model-written code splice file content.
        const updated = original.replace(find, () => args.replace ?? '');
        await fs.writeFile(target, updated, 'utf8');
        return {
          ok: true,
          output: `Edited ${args.path} (1 of ${occurrences} occurrence${occurrences === 1 ? '' : 's'} replaced).`,
        };
      },
    },
    {
      name: 'deleteFile',
      description: 'Delete a single file from the workspace.',
      parameters: { path: 'workspace-relative file path' },
      requiresApproval: true,
      async run(args) {
        const target = resolveSafe(required(args, 'path'));
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          return { ok: false, output: '', error: `${args.path} is not a file.` };
        }
        await fs.unlink(target);
        return { ok: true, output: `Deleted ${args.path}.` };
      },
    },
    {
      name: 'executeShell',
      description: 'Run a shell command in the workspace root (60s timeout).',
      parameters: { command: 'the shell command to run' },
      requiresApproval: true,
      async run(args) {
        return runShell(required(args, 'command'), workspaceRoot(), 60_000);
      },
    },
    {
      name: 'grep',
      description: 'Search workspace files for a regex pattern; returns path:line matches.',
      parameters: {
        pattern: 'regular expression (falls back to literal text if invalid)',
        glob: 'optional file glob, defaults to common source files',
      },
      requiresApproval: false,
      async run(args) {
        const rawPattern = required(args, 'pattern');
        let regex: RegExp;
        try {
          regex = new RegExp(rawPattern, 'i');
        } catch {
          regex = new RegExp(rawPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        const uris = await vscode.workspace.findFiles(args.glob || SOURCE_GLOB, EXCLUDE_GLOB, 400);
        const matches: string[] = [];
        for (const uri of uris) {
          if (matches.length >= 120) {
            break;
          }
          let content: string;
          try {
            content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          } catch {
            continue;
          }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && matches.length < 120; i++) {
            if (regex.test(lines[i])) {
              matches.push(
                `${vscode.workspace.asRelativePath(uri, false)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`
              );
            }
          }
        }
        log(`grep "${rawPattern}" → ${matches.length} match(es) across ${uris.length} file(s).`);
        return {
          ok: true,
          output: matches.length > 0 ? cap(matches.join('\n')) : 'No matches.',
        };
      },
    },
    {
      name: 'gitDiff',
      description: 'Show uncommitted changes (stat + full diff).',
      parameters: {},
      requiresApproval: false,
      async run() {
        return runShell('git diff --stat && git diff', workspaceRoot(), 30_000);
      },
    },
    {
      name: 'gitLog',
      description: 'Show recent commit history.',
      parameters: { count: 'number of commits (default 15)' },
      requiresApproval: false,
      async run(args) {
        const count = clampInt(args.count, 1, 100, 15);
        return runShell(`git log --oneline -n ${count}`, workspaceRoot(), 15_000);
      },
    },
    {
      name: 'runTests',
      description: 'Detect and run the workspace test suite (npm/pytest/go/cargo).',
      parameters: { command: 'optional explicit test command override' },
      requiresApproval: true,
      async run(args) {
        const root = workspaceRoot();
        let command: string | undefined = args.command;
        if (!command) {
          command = await detectTestCommand(root);
        }
        if (!command) {
          return {
            ok: false,
            output: '',
            error: 'No test setup detected (looked for package.json test script, pytest, go.mod, Cargo.toml).',
          };
        }
        log(`runTests → ${command}`);
        return runShell(command, root, 180_000);
      },
    },
    {
      name: 'lspDiagnostics',
      description: 'Current errors/warnings from VS Code language servers.',
      parameters: { path: 'optional workspace-relative file to filter by' },
      requiresApproval: false,
      async run(args) {
        const severityNames = ['error', 'warning', 'info', 'hint'];
        const all: [vscode.Uri, vscode.Diagnostic[]][] = args.path
          ? [[vscode.Uri.file(resolveSafe(args.path)), vscode.languages.getDiagnostics(vscode.Uri.file(resolveSafe(args.path)))]]
          : [...vscode.languages.getDiagnostics()];
        const lines: string[] = [];
        for (const [uri, diagnostics] of all) {
          for (const d of diagnostics) {
            if (lines.length >= 100) {
              break;
            }
            lines.push(
              `${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1} [${severityNames[d.severity] ?? 'info'}] ${d.message}`
            );
          }
        }
        return { ok: true, output: lines.length > 0 ? cap(lines.join('\n')) : 'No diagnostics — clean.' };
      },
    },
    {
      name: 'lspReferences',
      description: 'Find all references to the symbol at a file position.',
      parameters: {
        path: 'workspace-relative file path',
        line: '1-based line number of the symbol',
        character: '1-based column of the symbol',
      },
      requiresApproval: false,
      async run(args) {
        const target = vscode.Uri.file(resolveSafe(required(args, 'path')));
        const line = clampInt(args.line, 1, 1_000_000, 1) - 1;
        const character = clampInt(args.character, 1, 10_000, 1) - 1;
        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          target,
          new vscode.Position(line, character)
        );
        if (!locations || locations.length === 0) {
          return { ok: true, output: 'No references found.' };
        }
        const lines = locations
          .slice(0, 100)
          .map((loc) => `${vscode.workspace.asRelativePath(loc.uri, false)}:${loc.range.start.line + 1}`);
        return { ok: true, output: cap(lines.join('\n')) };
      },
    },
  ];
}

async function detectTestCommand(root: string): Promise<string | undefined> {
  const exists = async (rel: string): Promise<boolean> => {
    try {
      await fs.access(path.join(root, rel));
      return true;
    } catch {
      return false;
    }
  };
  if (await exists('package.json')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
        return 'npm test --silent';
      }
    } catch {
      // unreadable package.json — keep probing other ecosystems
    }
  }
  if ((await exists('pytest.ini')) || (await exists('pyproject.toml')) || (await exists('setup.py'))) {
    return 'pytest -q';
  }
  if (await exists('go.mod')) {
    return 'go test ./...';
  }
  if (await exists('Cargo.toml')) {
    return 'cargo test';
  }
  return undefined;
}

function required(args: Record<string, string>, key: string): string {
  const value = args[key];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required argument: ${key}`);
  }
  return value;
}

function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
