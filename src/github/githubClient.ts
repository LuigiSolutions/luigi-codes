/**
 * Luigi Codes — GitHub connector client.
 *
 * A zero-dependency GitHub REST v3 client used by BOTH surfaces: the VS Code
 * extension (token from VS Code's built-in GitHub sign-in) and the web app
 * (token supplied per request by the browser, never stored server-side).
 * This module MUST NOT import `vscode`.
 *
 * Privacy note: this is the one opt-in exception to "nothing leaves the
 * machine". Connecting GitHub sends requests to api.github.com with the
 * user's own token, for the repos the user names. Nothing else changes.
 */

type TokenProvider = () => Promise<string | undefined>;

export interface GitHubRepo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string;
  pushedAt: string;
}

export interface GitHubFileEntry {
  path: string;
  size: number;
}

const API = 'https://api.github.com';
const MAX_FILE_BYTES = 400_000;

/** owner/name, both segments in GitHub's allowed charset. */
export function validRepoName(repo: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

export class GitHubClient {
  constructor(private readonly tokenProvider: TokenProvider) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.tokenProvider();
    if (!token) {
      throw new Error('GitHub is not connected. Run "Luigi: Connect GitHub" first.');
    }
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'luigi-codes',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) {
      throw new Error('not found on GitHub (check the repo/path, and that your token can see it)');
    }
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(`GitHub ${response.status}: ${detail.message ?? 'request failed'}`);
    }
    return response.status === 204 ? {} : response.json();
  }

  /** The authenticated user's login, or throws when the token is bad. */
  async viewer(): Promise<string> {
    const user = (await this.request('/user')) as { login: string };
    return user.login;
  }

  async listRepos(limit = 100): Promise<GitHubRepo[]> {
    const raw = (await this.request(
      `/user/repos?per_page=${Math.min(limit, 100)}&sort=pushed`
    )) as {
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      pushed_at: string;
    }[];
    return raw.map((repo) => ({
      fullName: repo.full_name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      description: repo.description ?? '',
      pushedAt: repo.pushed_at,
    }));
  }

  async defaultBranch(repo: string): Promise<string> {
    const data = (await this.request(`/repos/${repo}`)) as { default_branch: string };
    return data.default_branch;
  }

  /** Every blob path in the tree at `ref` (default branch when omitted). */
  async listFiles(repo: string, ref?: string, cap = 500): Promise<GitHubFileEntry[]> {
    const branch = ref ?? (await this.defaultBranch(repo));
    const tree = (await this.request(
      `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    )) as { tree: { path: string; type: string; size?: number }[]; truncated: boolean };
    return tree.tree
      .filter((entry) => entry.type === 'blob')
      .slice(0, cap)
      .map((entry) => ({ path: entry.path, size: entry.size ?? 0 }));
  }

  async readFile(repo: string, filePath: string, ref?: string): Promise<string> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const data = (await this.request(
      `/repos/${repo}/contents/${encodePath(filePath)}${query}`
    )) as { type: string; size: number; content?: string; encoding?: string };
    if (data.type !== 'file') {
      throw new Error(`${filePath} is not a file`);
    }
    if (data.size > MAX_FILE_BYTES) {
      throw new Error(`${filePath} is too large to read (${data.size} bytes)`);
    }
    if (data.encoding !== 'base64' || typeof data.content !== 'string') {
      throw new Error(`unexpected encoding for ${filePath}`);
    }
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  /** Create `branch` from the default branch head if it does not exist yet. */
  async ensureBranch(repo: string, branch: string): Promise<void> {
    try {
      await this.request(`/repos/${repo}/git/ref/heads/${encodePath(branch)}`);
      return;
    } catch {
      // fall through and create it
    }
    const base = await this.defaultBranch(repo);
    const head = (await this.request(`/repos/${repo}/git/ref/heads/${encodePath(base)}`)) as {
      object: { sha: string };
    };
    await this.request(`/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head.object.sha }),
    });
  }

  /**
   * Create or update one file on `branch` with a commit. Returns the commit
   * URL. The branch is created from the default branch when missing, so a
   * review fix can always land on its own branch instead of main.
   */
  async commitFile(
    repo: string,
    branch: string,
    filePath: string,
    content: string,
    message: string
  ): Promise<string> {
    await this.ensureBranch(repo, branch);
    let existingSha: string | undefined;
    try {
      const current = (await this.request(
        `/repos/${repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`
      )) as { sha?: string };
      existingSha = current.sha;
    } catch {
      existingSha = undefined; // new file
    }
    const result = (await this.request(`/repos/${repo}/contents/${encodePath(filePath)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message,
        branch,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(existingSha ? { sha: existingSha } : {}),
      }),
    })) as { commit: { html_url: string } };
    return result.commit.html_url;
  }

  /** Open a pull request from `branch` into the default branch. */
  async openPullRequest(
    repo: string,
    branch: string,
    title: string,
    body: string
  ): Promise<string> {
    const base = await this.defaultBranch(repo);
    const pr = (await this.request(`/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, head: branch, base, body }),
    })) as { html_url: string };
    return pr.html_url;
  }
}

/** Encode a slash-separated path, keeping the slashes. */
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
