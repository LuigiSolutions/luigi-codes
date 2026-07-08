/**
 * Luigi Codes — extension entry point.
 *
 * Premium local AI coding agent by Luigi Solutions. Everything runs against a
 * local inference server (Ollama / LM Studio) — no cloud dependency, no data
 * leaves the machine unless the user wires a connector themselves.
 *
 * Boot order: logging → model router → tools → codebase index (background) →
 * memory → self-improvement → agent → UI surfaces (chat panel, sidebar,
 * status bar, terminal chat, web app server, GitHub connector) → 11 commands.
 */
import * as vscode from 'vscode';
import { LuigiAgent } from './agent/agentLoop';
import { ToolRegistry, createDefaultTools } from './agent/tools/toolRegistry';
import { LuigiChatViewProvider, LuigiServices } from './chat/chatPanel';
import { CodebaseIndex } from './context/codebaseIndex';
import { GitHubClient } from './github/githubClient';
import { createGitHubTools } from './github/githubTools';
import { SelfImprovement } from './improvement/selfImprove';
import { ModelRouter } from './inference/modelRouter';
import { MemorySystem } from './memory/memorySystem';
import { LuigiWebServer } from './web/webServer';
import { LuigiBrand, ansiFromHex } from './ui/designTokens';

let services: LuigiServices | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let webServer: LuigiWebServer | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const channel = vscode.window.createOutputChannel('Luigi Codes');
  context.subscriptions.push(channel);
  const log = (message: string): void => {
    channel.appendLine(`🍄 [${new Date().toISOString()}] ${message}`);
  };
  log('Luigi Codes activating. Premium local AI by Luigi Solutions.');

  // ── Core systems ─────────────────────────────────────────────────────────
  const router = new ModelRouter(log);
  const tools = new ToolRegistry(log);
  for (const tool of createDefaultTools(log)) {
    tools.register(tool);
  }

  // GitHub connector: VS Code's built-in GitHub sign-in supplies the token
  // (nothing stored by Luigi). Tools work once the user connects; before
  // that they return a clear "connect first" error instead of hanging.
  const github = new GitHubClient(async () => {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: false,
    });
    return session?.accessToken;
  });
  for (const tool of createGitHubTools(github, log)) {
    tools.register(tool);
  }

  const index = new CodebaseIndex(router, log);
  const memory = new MemorySystem(context.globalStorageUri, router, log);
  const improve = new SelfImprovement(context.globalStorageUri, log);
  const agent = new LuigiAgent(router, tools, index, memory, improve, log);
  context.subscriptions.push(router, index, agent);

  services = {
    extensionUri: context.extensionUri,
    router,
    tools,
    agent,
    index,
    memory,
    improve,
    log,
  };

  // The chat lives in the activity-bar view — docked like a chat assistant.
  const chatView = new LuigiChatViewProvider(services);

  // ── Status bar — Luigi lives bottom-right, gold mushroom always on ───────
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = 'Luigi Codes';
  statusBarItem.text = '🍄 Luigi';
  statusBarItem.tooltip = 'Luigi Codes · click for agent status';
  statusBarItem.command = 'luigi.showAgentStatus';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    agent.onProgress((event) => {
      if (statusBarItem) {
        statusBarItem.text =
          event.phase === 'done' ? '🍄 Luigi' : `$(sync~spin) Luigi · ${event.phase}`;
      }
    }),
    index.onDidUpdate((stats) => {
      log(`Index updated: ${stats.fileCount} files, ${stats.symbolCount} symbols.`);
    }),
    // Correction learning: when a human edits and saves a file Luigi authored,
    // capture the before/after as an on-device training pair. Pure-local, no
    // model call, no data leaves the machine.
    vscode.workspace.onDidSaveTextDocument((document) => {
      const relative = vscode.workspace.asRelativePath(document.uri, false);
      if (improve.reconcileSavedFile(relative, document.getText())) {
        log(`Correction captured from edit to ${relative}.`);
      }
    })
  );

  // ── Background boot: model detection, memory init, workspace indexing ────
  void (async () => {
    try {
      const models = await router.detectAvailableModels();
      log(
        models.length > 0
          ? `Detected ${models.length} local model(s): ${models.map((m) => m.id).join(', ')}`
          : 'No local models detected. Is Ollama running? (https://ollama.com)'
      );
    } catch (error) {
      log(`Model detection failed: ${describe(error)}`);
    }
    try {
      await memory.initialize();
      log(`Memory online (${memory.status}).`);
    } catch (error) {
      log(`Memory init failed: ${describe(error)}`);
    }
    try {
      await improve.initialize();
    } catch (error) {
      log(`Self-improvement init failed: ${describe(error)}`);
    }
    try {
      const stats = await index.indexWorkspace();
      log(`Workspace indexed: ${stats.fileCount} files, ${stats.symbolCount} symbols.`);
    } catch (error) {
      log(`Indexing failed: ${describe(error)}`);
    }
  })();

  // ── Chat view (activity bar) ──────────────────────────────────────────────
  context.subscriptions.push(
    chatView,
    vscode.window.registerWebviewViewProvider(LuigiChatViewProvider.viewId, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Commands (all 11) ────────────────────────────────────────────────────
  const openChat = (): void => {
    void chatView.reveal();
  };

  const withSelection = (
    action: (code: string, language: string, fileName: string) => void
  ): void => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage('Luigi: select some code first.');
      return;
    }
    const code = editor.document.getText(editor.selection);
    action(code, editor.document.languageId, workspaceRelative(editor.document.uri));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('luigi.openChat', openChat),

    vscode.commands.registerCommand('luigi.explainCode', () =>
      withSelection((code, language, fileName) => {
        if (!services) {
          return;
        }
        chatView.ask(
          `Explain this ${language} code from ${fileName}. Walk through what it does, why it is structured this way, and anything subtle.\n\n\`\`\`${language}\n${code}\n\`\`\``,
          { mode: 'chat', kind: 'code-explanation' }
        );
      })
    ),

    vscode.commands.registerCommand('luigi.improveCode', () =>
      withSelection((code, language, fileName) => {
        if (!services) {
          return;
        }
        chatView.ask(
          `Improve this ${language} code from ${fileName}. Keep behavior identical; raise readability, safety, and performance. Return the improved code with a short list of changes.\n\n\`\`\`${language}\n${code}\n\`\`\``,
          { mode: 'chat', kind: 'code-generation' }
        );
      })
    ),

    vscode.commands.registerCommand('luigi.generateTests', () =>
      withSelection((code, language, fileName) => {
        if (!services) {
          return;
        }
        chatView.ask(
          `Generate thorough unit tests for this ${language} code from ${fileName}. Cover the happy path, edge cases, and failure modes. Use the idiomatic test framework for the language.\n\n\`\`\`${language}\n${code}\n\`\`\``,
          { mode: 'chat', kind: 'test-generation' }
        );
      })
    ),

    vscode.commands.registerCommand('luigi.fixBugs', () =>
      withSelection((code, language, fileName) => {
        if (!services) {
          return;
        }
        chatView.ask(
          `Find and fix bugs in this ${language} code from ${fileName}. List each bug (what breaks, and with what input), then return the corrected code.\n\n\`\`\`${language}\n${code}\n\`\`\``,
          { mode: 'chat', kind: 'bug-fixing' }
        );
      })
    ),

    vscode.commands.registerCommand('luigi.reviewCode', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !services) {
        void vscode.window.showWarningMessage('Luigi: open a file to review.');
        return;
      }
      const document = editor.document;
      const body = document.getText();
      // Very large files are trimmed so a small local context window stays useful.
      const excerpt = body.length > 24000 ? `${body.slice(0, 24000)}\n… (truncated)` : body;
      chatView.ask(
        `Review ${workspaceRelative(document.uri)} (${document.languageId}). Report correctness bugs first, then design and clarity issues, each with file-line references and a suggested fix.\n\n\`\`\`${document.languageId}\n${excerpt}\n\`\`\``,
        { mode: 'chat', kind: 'code-review' }
      );
    }),

    vscode.commands.registerCommand('luigi.terminalChat', () => {
      if (!services) {
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: 'Luigi Chat',
        pty: new LuigiTerminalChat(services),
      });
      terminal.show();
    }),

    vscode.commands.registerCommand('luigi.showAgentStatus', async () => {
      if (!services) {
        return;
      }
      const routerStatus = services.router.statusSummary();
      const indexStats = services.index.stats;
      const memoryCount = services.memory.getTaskHistory(1000).length;
      const tune = services.improve.shouldFineTune();
      const perf = Object.entries(services.router.performanceSnapshot());
      const perfLine =
        perf.length === 0
          ? 'no runs recorded yet'
          : perf
              .map(([id, p]) => `${id} ${(p.successRate * 100).toFixed(0)}% over ${p.runs}`)
              .join(' · ');
      const lines = [
        `$(circuit-board) Models: ${routerStatus}`,
        `$(pulse) Observed: ${perfLine}`,
        `$(database) Index: ${indexStats.fileCount} files · ${indexStats.symbolCount} symbols · ${indexStats.language || 'no dominant language'}`,
        `$(history) Memory: ${memoryCount} tasks remembered (${services.memory.status})`,
        `$(rocket) Self-improvement: ${tune.datasetSize} training pairs · ${tune.ready ? 'fine-tune ready' : tune.reason}`,
        `$(tools) Tools: ${services.tools.list().length} registered`,
      ];
      const pick = await vscode.window.showQuickPick(lines, {
        title: '🍄 Luigi Codes · Agent Status',
        placeHolder: 'Luigi Solutions · private local AI',
      });
      if (pick) {
        channel.show(true);
      }
    }),

    vscode.commands.registerCommand('luigi.connectGitHub', async () => {
      try {
        const session = await vscode.authentication.getSession('github', ['repo'], {
          createIfNone: true,
        });
        log(`GitHub connected as ${session.account.label}.`);
        void vscode.window.showInformationMessage(
          `Luigi is connected to GitHub as ${session.account.label}. Ask Luigi to list, review, or improve your repos; commits and pull requests always ask for your approval first.`
        );
      } catch (error) {
        void vscode.window.showErrorMessage(`GitHub sign-in did not complete: ${describe(error)}`);
      }
    }),

    vscode.commands.registerCommand('luigi.openWebApp', async () => {
      const config = vscode.workspace.getConfiguration('luigi');

      if (webServer?.running) {
        const primary = webServer.urls[0];
        const phone = webServer.urls[1];
        const choice = await vscode.window.showInformationMessage(
          `Luigi web app is running: ${webServer.urls.length} URL(s) available.`,
          'Open in Browser',
          phone ? 'Copy Phone URL' : 'Copy URL',
          'Stop Server'
        );
        if (choice === 'Open in Browser') {
          await vscode.env.openExternal(vscode.Uri.parse(primary));
        } else if (choice === 'Copy URL') {
          await vscode.env.clipboard.writeText(primary);
        } else if (choice === 'Copy Phone URL') {
          await vscode.env.clipboard.writeText(phone);
        } else if (choice === 'Stop Server') {
          await webServer.stop();
          webServer = undefined;
          log('Web app stopped by user.');
        }
        return;
      }

      const provider = config.get<string>('model.provider', 'ollama');
      const allowLan = config.get<boolean>('web.allowLan', false);
      const server = new LuigiWebServer({
        host: allowLan ? '0.0.0.0' : '127.0.0.1',
        port: config.get<number>('web.port', 8091),
        modelEndpoint: config.get<string>('model.endpoint', 'http://localhost:11434'),
        wire: provider === 'ollama' ? 'ollama' : 'openai',
        model: config.get<string>('model.primaryModel', ''),
        theme: config.get<'premium-black' | 'premium-dark'>('ui.theme', 'premium-black'),
        mediaDir: vscode.Uri.joinPath(context.extensionUri, 'media').fsPath,
        log,
      });
      try {
        const { urls } = await server.start();
        webServer = server;
        const phone = urls[1];
        const detail = phone
          ? `Phone (same Wi-Fi): ${phone}`
          : 'Local only. Enable luigi.web.allowLan to reach it from your phone.';
        log(`Web app started: ${urls.join(' · ')}`);
        const choice = await vscode.window.showInformationMessage(
          `🍄 Luigi web app running at ${urls[0]}`,
          { detail, modal: false },
          'Open in Browser',
          phone ? 'Copy Phone URL' : 'Copy URL'
        );
        if (choice === 'Open in Browser') {
          await vscode.env.openExternal(vscode.Uri.parse(urls[0]));
        } else if (choice === 'Copy URL') {
          await vscode.env.clipboard.writeText(urls[0]);
        } else if (choice === 'Copy Phone URL') {
          await vscode.env.clipboard.writeText(phone);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Luigi web app could not start: ${describe(error)}. Is port ${config.get<number>('web.port', 8091)} already in use? Change luigi.web.port and retry.`
        );
      }
    }),

    vscode.commands.registerCommand('luigi.exportTrainingData', async () => {
      if (!services) {
        return;
      }
      await services.improve.initialize();
      const { train, valid, count } = services.improve.exportTrainingJsonl();
      if (count === 0) {
        void vscode.window.showInformationMessage(
          'Luigi: no training data collected yet. Use the agent and accept/edit its output to build a dataset.'
        );
        return;
      }
      const dir = vscode.Uri.joinPath(context.globalStorageUri, 'finetune');
      await vscode.workspace.fs.createDirectory(dir);
      const enc = new TextEncoder();
      const trainUri = vscode.Uri.joinPath(dir, 'train.jsonl');
      await vscode.workspace.fs.writeFile(trainUri, enc.encode(train + '\n'));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, 'valid.jsonl'),
        enc.encode(valid + '\n')
      );
      log(`Exported ${count} training example(s) to ${dir.fsPath}`);
      const choice = await vscode.window.showInformationMessage(
        `Luigi: exported ${count} training example(s) to ${dir.fsPath}. Fine-tune locally with MLX; see TRAINING.md.`,
        'Reveal Folder'
      );
      if (choice === 'Reveal Folder') {
        await vscode.commands.executeCommand('revealFileInOS', trainUri);
      }
    })
  );

  // Deep link from the website: vscode://LuigiSolutions.luigi-codes/open-web-app
  // lets luigi-codes.vercel.app start the web app on this machine when its
  // launcher can't find one running. The browser asks the user first.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri: vscode.Uri) => {
        if (uri.path === '/open-web-app') {
          log('Web app requested via deep link from the site.');
          void vscode.commands.executeCommand('luigi.openWebApp');
        }
      },
    })
  );

  // The web server outlives no window: stop it with the extension.
  context.subscriptions.push({
    dispose: () => {
      void webServer?.stop();
      webServer = undefined;
    },
  });

  log('Luigi Codes ready. 11 commands registered.');
}

export function deactivate(): void {
  // Disposables registered on the extension context are disposed by VS Code;
  // this hook only clears module state so a reload starts clean.
  services = undefined;
  statusBarItem = undefined;
  webServer = undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

/**
 * Terminal chat — a pseudoterminal REPL against the local model, styled with
 * 24-bit ANSI in the exact brand values: gold #c9a86a, ink-muted #9c948a.
 */
class LuigiTerminalChat implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
  private buffer = '';
  private busy = false;
  private closed = false;
  private readonly history: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    {
      role: 'system',
      content:
        'You are Luigi, a concise expert coding assistant by Luigi Solutions, running fully locally. Answer tersely; prefer code over prose.',
    },
  ];

  private static readonly GOLD = ansiFromHex(LuigiBrand.colors.accent.gold);
  private static readonly MUTED = ansiFromHex(LuigiBrand.colors.foreground.secondary);
  private static readonly RESET = '\x1b[0m';

  constructor(private readonly deps: LuigiServices) {}

  open(): void {
    this.write(
      `${LuigiTerminalChat.GOLD}🍄 LUIGI CODES${LuigiTerminalChat.RESET}` +
        `${LuigiTerminalChat.MUTED} · terminal chat · local · private${LuigiTerminalChat.RESET}\r\n\r\n`
    );
    this.prompt();
  }

  close(): void {
    this.closed = true;
    this.writeEmitter.dispose();
  }

  /** A streaming reply may still be arriving after the terminal closes. */
  private write(text: string): void {
    if (!this.closed) {
      this.writeEmitter.fire(text);
    }
  }

  handleInput(data: string): void {
    if (this.busy) {
      return;
    }
    for (const char of data) {
      if (char === '\r') {
        this.write('\r\n');
        const line = this.buffer.trim();
        this.buffer = '';
        if (line.length > 0) {
          void this.respond(line);
        } else {
          this.prompt();
        }
      } else if (char === '\x7f') {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          this.write('\b \b');
        }
      } else if (char >= ' ') {
        this.buffer += char;
        this.write(char);
      }
    }
  }

  private prompt(): void {
    this.write(`${LuigiTerminalChat.GOLD}luigi ›${LuigiTerminalChat.RESET} `);
  }

  private async respond(line: string): Promise<void> {
    this.busy = true;
    this.history.push({ role: 'user', content: line });
    try {
      const reply = await this.deps.router.chat(this.history, {
        taskKind: 'chat',
        onToken: (token) => {
          this.write(token.replace(/\n/g, '\r\n'));
        },
      });
      this.history.push({ role: 'assistant', content: reply });
      this.write('\r\n\r\n');
    } catch (error) {
      this.write(
        `\r\n${LuigiTerminalChat.MUTED}Luigi could not reach a local model: ${describe(error)}${LuigiTerminalChat.RESET}\r\n\r\n`
      );
    }
    this.busy = false;
    this.prompt();
  }
}
