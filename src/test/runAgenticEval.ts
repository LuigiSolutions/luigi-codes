/**
 * Agentic eval launcher (Phase 0.4). Like runTest.ts but for the agentic suite:
 * opens a fresh scratch workspace and runs the real 5-phase loop against a model
 * server. NOT part of `npm test` (that must pass with no server); this needs one.
 *
 * Usage: npm run eval:agentic
 * Env: LUIGI_AGENTIC_ENDPOINT (default http://localhost:8082), LUIGI_AGENTIC_MODEL,
 *      LUIGI_AGENTIC_N, LUIGI_AGENTIC_LIMIT.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  for (const name of Object.keys(process.env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) {
      delete process.env[name];
    }
  }

  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './agentic/index');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luigi-agentic-ws-'));

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
      extensionTestsEnv: {
        LUIGI_AGENTIC_WS: workspace,
        LUIGI_AGENTIC_ENDPOINT: process.env.LUIGI_AGENTIC_ENDPOINT || 'http://localhost:8082',
        LUIGI_AGENTIC_MODEL: process.env.LUIGI_AGENTIC_MODEL || 'luigi-base',
        LUIGI_AGENTIC_N: process.env.LUIGI_AGENTIC_N || '3',
        ...(process.env.LUIGI_AGENTIC_LIMIT ? { LUIGI_AGENTIC_LIMIT: process.env.LUIGI_AGENTIC_LIMIT } : {}),
      },
    });
  } catch (error) {
    console.error('Agentic eval failed to run:', error);
    process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
