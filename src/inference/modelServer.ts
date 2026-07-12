/**
 * Luigi Codes — local trained-model server auto-start.
 *
 * Both the VS Code extension and the standalone web app point at Luigi's own
 * fine-tuned model by default (provider "custom", localhost:8080). Rather than
 * requiring a manual `serve-model.py` beforehand, whichever surface launches
 * first checks the endpoint and starts the server itself if nothing answers.
 * Vscode-free (spawned from both the extension host and plain Node) — see
 * streamText.ts for the same pattern.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LUIGI_TRAINED_MODEL_ID } from './modelRouter';

export interface EnsureLocalModelServerOptions {
  provider: string;
  endpoint: string;
  /** Absolute path to the bundled scripts/serve-model.py for this install. */
  scriptPath: string;
  log: (message: string) => void;
}

/**
 * Starts Luigi's fine-tuned model server when the configured "custom"
 * endpoint is a loopback address and nothing is answering there yet. No-ops
 * safely (just a log line) on any machine missing the mlx venv, adapter
 * weights, or bundled script — e.g. a stranger's first install before they've
 * set any of that up.
 */
export async function ensureLocalModelServer(options: EnsureLocalModelServerOptions): Promise<void> {
  const { provider, endpoint, scriptPath, log } = options;
  if (provider !== 'custom') {
    return;
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return; // only auto-launch a server we would be the one running
  }

  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      return; // already up
    }
  } catch {
    // not reachable — fall through and try to start it
  }

  const pythonPath = path.join(os.homedir(), '.luigi-mlx', 'bin', 'python');
  const adapterPath = path.join(os.homedir(), 'luigi-finetune', 'luigi-adapter');
  if (!existsSync(pythonPath) || !existsSync(adapterPath) || !existsSync(scriptPath)) {
    log(
      "Luigi's trained model server isn't set up on this machine (needs ~/.luigi-mlx + " +
        '~/luigi-finetune/luigi-adapter); skipping auto-start. See TRAINING.md.',
    );
    return;
  }

  const port = url.port || '8080';
  log(`Starting Luigi's trained model server on port ${port}...`);
  const child = spawn(
    pythonPath,
    [scriptPath, '--model', LUIGI_TRAINED_MODEL_ID, '--adapter-path', adapterPath, '--port', port],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}
