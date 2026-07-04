/**
 * Luigi Codes — integration test launcher.
 *
 * Downloads a VS Code build (cached in .vscode-test/), opens a throwaway
 * fixture workspace, and runs the mocha suite inside the extension host.
 * Everything here must pass with NO model server running.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  // When this launcher itself runs inside a VS Code terminal, inherited
  // Electron/VS Code variables (ELECTRON_RUN_AS_NODE above all) make the
  // downloaded VS Code start as plain node instead of an extension host.
  for (const name of Object.keys(process.env)) {
    if (name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_')) {
      delete process.env[name];
    }
  }

  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');

  // A tiny real workspace so workspace-scoped tools and the index have ground
  // to stand on without touching the extension's own repo.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'luigi-test-ws-'));
  fs.writeFileSync(
    path.join(workspace, 'sample.ts'),
    'export function hello(name: string): string {\n  return `Hello, ${name}`;\n}\n',
    'utf8'
  );

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust'],
    });
  } catch (error) {
    console.error('Luigi Codes tests failed:', error);
    // exitCode, not exit(): let the finally block clean the temp workspace.
    process.exitCode = 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
