/**
 * Luigi Codes — GitHub tools for the agent.
 *
 * Read tools run freely; anything that writes to a repo (commit, pull
 * request) sits behind the same human-approval gate as local file writes.
 * Commits always land on a named branch (created from the default branch
 * when missing), never force-anything, so the user's history stays safe.
 */
import type { LuigiTool, ToolResult } from '../agent/tools/toolRegistry';
import { GitHubClient, validRepoName } from './githubClient';

type Logger = (message: string) => void;

function fail(error: string): ToolResult {
  return { ok: false, output: '', error };
}

function capText(text: string, limit = 20000): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (${text.length - limit} chars truncated)`
    : text;
}

export function createGitHubTools(client: GitHubClient, log: Logger): LuigiTool[] {
  const repoArg = (args: Record<string, string>): string | undefined => {
    const repo = (args.repo ?? '').trim();
    return validRepoName(repo) ? repo : undefined;
  };

  return [
    {
      name: 'githubListRepos',
      description: 'List the connected GitHub account\'s repositories (most recently pushed first).',
      parameters: {},
      requiresApproval: false,
      async run(): Promise<ToolResult> {
        const repos = await client.listRepos();
        const lines = repos.map(
          (r) => `${r.fullName}${r.private ? ' (private)' : ''} [${r.defaultBranch}] ${r.description}`.trim()
        );
        return { ok: true, output: capText(lines.join('\n')) || '(no repositories)' };
      },
    },
    {
      name: 'githubListFiles',
      description: 'List file paths in a GitHub repository (default branch unless ref is given).',
      parameters: {
        repo: 'Repository as owner/name, e.g. LuigiSolutions/luigi-codes',
        ref: 'Optional branch or commit to list instead of the default branch',
      },
      requiresApproval: false,
      async run(args): Promise<ToolResult> {
        const repo = repoArg(args);
        if (!repo) {
          return fail('repo must be owner/name');
        }
        const files = await client.listFiles(repo, args.ref || undefined);
        return { ok: true, output: capText(files.map((f) => f.path).join('\n')) || '(empty repo)' };
      },
    },
    {
      name: 'githubReadFile',
      description: 'Read one file from a GitHub repository so it can be reviewed or improved.',
      parameters: {
        repo: 'Repository as owner/name',
        path: 'File path inside the repository',
        ref: 'Optional branch or commit (default branch when omitted)',
      },
      requiresApproval: false,
      async run(args): Promise<ToolResult> {
        const repo = repoArg(args);
        if (!repo || !args.path) {
          return fail('repo (owner/name) and path are required');
        }
        const content = await client.readFile(repo, args.path, args.ref || undefined);
        return { ok: true, output: capText(content, 60000) };
      },
    },
    {
      name: 'githubCommitFile',
      description:
        'Commit one file (create or update) to a branch of a GitHub repository. The branch is created from the default branch when it does not exist. Use a feature branch, then githubOpenPullRequest.',
      parameters: {
        repo: 'Repository as owner/name',
        branch: 'Branch to commit to (created if missing); prefer luigi/<topic>',
        path: 'File path inside the repository',
        content: 'The COMPLETE new file content',
        message: 'Commit message describing the change',
      },
      requiresApproval: true,
      async run(args): Promise<ToolResult> {
        const repo = repoArg(args);
        if (!repo || !args.branch || !args.path || args.content === undefined || !args.message) {
          return fail('repo, branch, path, content, and message are all required');
        }
        const url = await client.commitFile(repo, args.branch, args.path, args.content, args.message);
        log(`GitHub: committed ${args.path} to ${repo}@${args.branch}`);
        return { ok: true, output: `Committed: ${url}` };
      },
    },
    {
      name: 'githubOpenPullRequest',
      description: 'Open a pull request from a branch into the default branch of a GitHub repository.',
      parameters: {
        repo: 'Repository as owner/name',
        branch: 'The branch with the changes (the head)',
        title: 'Pull request title',
        body: 'Pull request description (what changed and why)',
      },
      requiresApproval: true,
      async run(args): Promise<ToolResult> {
        const repo = repoArg(args);
        if (!repo || !args.branch || !args.title) {
          return fail('repo, branch, and title are required');
        }
        const url = await client.openPullRequest(repo, args.branch, args.title, args.body ?? '');
        log(`GitHub: opened PR for ${repo} from ${args.branch}`);
        return { ok: true, output: `Pull request: ${url}` };
      },
    },
  ];
}
