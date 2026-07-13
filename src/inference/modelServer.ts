/**
 * Luigi Codes — local trained-model server auto-start.
 *
 * Both the VS Code extension and the standalone web app point at Luigi's own
 * fine-tuned model by default (provider "custom", localhost:8080). Rather than
 * requiring a manual `serve-model.py` beforehand, whichever surface launches
 * first checks the endpoint and starts the server itself if nothing answers.
 * Vscode-free (spawned from both the extension host and plain Node) — see
 * streamText.ts / modelDefaults.ts for the same pattern.
 */
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LUIGI_TRAINED_MODEL_ID } from './modelDefaults';

export interface EnsureLocalModelServerOptions {
  provider: string;
  endpoint: string;
  /** Absolute path to the bundled scripts/serve-model.py for this install. */
  scriptPath: string;
  log: (message: string) => void;
}

/**
 * Starts Luigi's fine-tuned model server when the configured "custom"
 * endpoint is a loopback address and nothing is answering there yet. Returns
 * the spawned ChildProcess so the caller can terminate it on shutdown, or
 * undefined when no server was started (already up, wrong provider, remote
 * endpoint, or prerequisites missing). No-ops safely (just a log line) on any
 * machine missing the mlx venv, adapter weights, or bundled script — e.g. a
 * stranger's first install before they've set any of that up.
 */
export async function ensureLocalModelServer(
  options: EnsureLocalModelServerOptions,
): Promise<ChildProcess | undefined> {
  const { provider, scriptPath, log } = options;
  if (provider !== 'custom') {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(options.endpoint);
  } catch {
    return undefined;
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    return undefined; // only auto-launch a server we would be the one running
  }
  // Normalize away any trailing slash so we probe .../v1/models, not ...//v1/models.
  const endpoint = `${url.protocol}//${url.host}`;

  try {
    const response = await fetch(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(1500) });
    // ANY completed HTTP response means something already owns this port — an
    // already-running Luigi server, or an unrelated service. Either way, do not
    // spawn a second process that would just fail to bind (and, for a 7B model,
    // burn gigabytes loading weights before dying). Only a network-level miss
    // (connection refused / timeout, caught below) means the port is free.
    void response;
    return undefined;
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
    return undefined;
  }

  // Spawn on the SAME port requests will go to. url.port is '' for an implicit
  // default port, so fall back to the protocol default rather than assuming 8080.
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  log(`Starting Luigi's trained model server on port ${port}...`);
  try {
    const child = spawn(
      pythonPath,
      [scriptPath, '--model', LUIGI_TRAINED_MODEL_ID, '--adapter-path', adapterPath, '--port', port],
      { detached: true, stdio: 'ignore' },
    );
    // A detached child that emits 'error' with no listener throws an uncaught
    // exception in this process (crashing the extension host / the web app).
    // Log and swallow instead — a failed auto-start must stay a soft failure.
    child.on('error', (error) => {
      log(`Luigi's trained model server failed to start: ${describe(error)}`);
    });
    child.unref();
    return child;
  } catch (error) {
    log(`Luigi's trained model server failed to start: ${describe(error)}`);
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
