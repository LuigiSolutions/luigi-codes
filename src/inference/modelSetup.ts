/**
 * Luigi Codes — one-click local model setup.
 *
 * Goal: any user launches Luigi and has a working local model with no manual
 * steps. On Apple Silicon with Luigi's own fine-tuned model set up, the server
 * auto-starts (see modelServer.ts) and there's nothing to do. Everywhere else
 * (Windows / Linux / Intel Mac, or an Apple machine that hasn't set up the mlx
 * model yet) this provisions a model through Ollama, which is cross-platform
 * and handles download + serving. The router's backend fallback then routes to
 * whatever this makes available.
 *
 * Extension-side (uses vscode); never imported by the standalone web app.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

import { RECOMMENDED_EMBED_MODEL, RECOMMENDED_OLLAMA_MODEL } from './modelDefaults';
import { ModelRouter } from './modelRouter';

const execFileAsync = promisify(execFile);
const OLLAMA_ENDPOINT = 'http://localhost:11434';
const OLLAMA_DOWNLOAD = 'https://ollama.com/download';

type Logger = (message: string) => void;

/** True when the `ollama` CLI is installed and runnable on this machine. */
async function ollamaInstalled(): Promise<boolean> {
  try {
    await execFileAsync('ollama', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** True when the Ollama server answers on its port. */
async function ollamaServing(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Start `ollama serve` in the background and wait until it answers (or give up). */
async function startOllama(log: Logger): Promise<boolean> {
  if (await ollamaServing()) {
    return true;
  }
  log('Starting Ollama...');
  try {
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => log(`Could not start Ollama: ${describe(error)}`));
    child.unref();
  } catch (error) {
    log(`Could not start Ollama: ${describe(error)}`);
    return false;
  }
  for (let i = 0; i < 20; i++) {
    await delay(500);
    if (await ollamaServing()) {
      return true;
    }
  }
  return false;
}

/** `ollama pull <model>`, streaming progress into a VS Code progress notification. */
async function pullModel(
  model: string,
  progress: vscode.Progress<{ message?: string }>,
  log: Logger,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onData = (buffer: Buffer): void => {
      // Ollama emits carriage-return progress lines ("pulling ... 42%"); show the last.
      const line = buffer.toString().split(/[\r\n]/).filter(Boolean).pop();
      if (line) {
        progress.report({ message: `${model}: ${line.trim()}` });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (error) => {
      log(`ollama pull ${model} failed: ${describe(error)}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Ensure a usable local model exists, guiding the user through Ollama when
 * needed. Safe to run any time (idempotent): if a model is already reachable it
 * just reports readiness.
 */
export async function setUpLocalModel(router: ModelRouter, log: Logger): Promise<void> {
  const available = await router.detectAvailableModels();
  if (available.length > 0) {
    void vscode.window.showInformationMessage(
      `Luigi is ready. Using ${available[0].name} at ${router.activeEndpoint}.`,
    );
    return;
  }

  if (!(await ollamaInstalled())) {
    const pick = await vscode.window.showInformationMessage(
      'Luigi needs a local model to run. The simplest cross-platform way is Ollama (free, ' +
        'runs on Mac, Windows, and Linux). Install it, then run "Luigi: Set Up Local Model" again.',
      'Get Ollama',
      'Not now',
    );
    if (pick === 'Get Ollama') {
      void vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD));
    }
    return;
  }

  if (!(await startOllama(log))) {
    void vscode.window.showErrorMessage(
      'Ollama is installed but would not start. Try running "ollama serve" in a terminal, then retry.',
    );
    return;
  }

  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Setting up Luigi’s local model', cancellable: false },
    async (progress) => {
      progress.report({ message: `Downloading ${RECOMMENDED_OLLAMA_MODEL} (a few GB, one time)...` });
      const chatOk = await pullModel(RECOMMENDED_OLLAMA_MODEL, progress, log);
      if (!chatOk) {
        return false;
      }
      // Best-effort: embeddings power the index + memory but aren't required.
      await pullModel(RECOMMENDED_EMBED_MODEL, progress, log);
      return true;
    },
  );

  if (!ok) {
    void vscode.window.showErrorMessage(
      `Could not download ${RECOMMENDED_OLLAMA_MODEL} via Ollama. See the Luigi Codes output channel for details.`,
    );
    return;
  }

  await router.detectAvailableModels();
  void vscode.window.showInformationMessage(
    `Luigi is ready. Running ${RECOMMENDED_OLLAMA_MODEL} locally via Ollama.`,
  );
}

/**
 * First-run nudge: if no model is reachable anywhere, offer to set one up
 * instead of letting the first chat fail with a raw fetch error. No-ops when a
 * model is already available.
 */
export async function maybeOfferModelSetup(router: ModelRouter, log: Logger): Promise<void> {
  const available = await router.detectAvailableModels();
  if (available.length > 0) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    'Luigi has no local model to talk to yet. Set one up now?',
    'Set up model',
    'Later',
  );
  if (pick === 'Set up model') {
    await setUpLocalModel(router, log);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
