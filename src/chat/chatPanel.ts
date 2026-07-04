/**
 * Luigi Codes — the chat view.
 *
 * LuigiChatViewProvider hosts the full conversation as an activity-bar webview
 * view — docked in the side bar like a chat assistant, draggable to the
 * secondary side bar or bottom panel. Streams tokens from the local model,
 * renders agent progress live, and carries the full Luigi Solutions look:
 * warm near-black canvas, gold hairline frames, uppercase gold eyebrows,
 * editorial serif welcome.
 */
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { AgentProgressEvent, LuigiAgent } from '../agent/agentLoop';
import { ToolRegistry } from '../agent/tools/toolRegistry';
import { CodebaseIndex } from '../context/codebaseIndex';
import { SelfImprovement } from '../improvement/selfImprove';
import { ChatMessage, ModelRouter, TaskKind } from '../inference/modelRouter';
import { MemorySystem } from '../memory/memorySystem';
import { cssVariables, LuigiBrand, LuigiTheme } from '../ui/designTokens';
import { escapeHtml, renderInline, renderMarkdown } from './markdown';

/** Everything the UI surfaces need, assembled once in extension.ts. */
export interface LuigiServices {
  extensionUri: vscode.Uri;
  router: ModelRouter;
  tools: ToolRegistry;
  agent: LuigiAgent;
  index: CodebaseIndex;
  memory: MemorySystem;
  improve: SelfImprovement;
  log: (message: string) => void;
}

interface AskOptions {
  mode: 'chat' | 'agent';
  kind?: TaskKind;
}

type InboundMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; mode: 'chat' | 'agent' }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'copied' };

export class LuigiChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'luigi.sidebar';
  public static current: LuigiChatViewProvider | undefined;

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private history: ChatMessage[] = [];
  private abort: AbortController | undefined;
  private webviewReady = false;
  private disposed = false;
  private readonly pendingAsks: { text: string; options: AskOptions }[] = [];

  constructor(private readonly services: LuigiServices) {
    LuigiChatViewProvider.current = this;
    this.resetHistory();
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.postContext()),
      // Only forward progress while a run is active. After New Chat clears
      // this.abort, an agent still winding down must not repaint the fresh chat.
      this.services.agent.onProgress((event) => {
        if (this.abort) {
          this.post({ type: 'agentProgress', event });
        }
      }),
      this.services.index.onDidUpdate(() => this.postContext())
    );
  }

  /** Called by VS Code when the view first becomes visible. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.services.extensionUri, 'media')],
    };
    view.webview.html = this._getHtmlContent(view.webview);
    view.webview.onDidReceiveMessage(
      (raw) => void this.onMessage(raw as InboundMessage),
      null,
      this.disposables
    );
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
      }
    });
  }

  /** Bring the chat into view (side bar), resolving it if needed. */
  public async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${LuigiChatViewProvider.viewId}.focus`);
  }

  /** Programmatic entry used by the editor commands (explain / improve / …). */
  public ask(text: string, options: AskOptions): void {
    void this.reveal();
    if (!this.webviewReady) {
      this.pendingAsks.push({ text, options });
      return;
    }
    void this.run(text, options.mode, options.kind);
  }

  public dispose(): void {
    LuigiChatViewProvider.current = undefined;
    this.disposed = true;
    this.abort?.abort();
    // Clear so an in-flight run's catch treats itself as superseded and does
    // not post to the webview we are about to tear down.
    this.abort = undefined;
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }

  // ── Pipeline ───────────────────────────────────────────────────────────────

  private async onMessage(message: InboundMessage): Promise<void> {
    switch (message.type) {
      case 'ready': {
        this.webviewReady = true;
        this.postContext();
        for (const queued of this.pendingAsks.splice(0)) {
          void this.run(queued.text, queued.options.mode, queued.options.kind);
        }
        break;
      }
      case 'send':
        await this.run(message.text, message.mode);
        break;
      case 'stop':
        this.abort?.abort();
        break;
      case 'newChat':
        // Abort first: a still-streaming run would otherwise push its reply
        // into the freshly reset history and leak into the new conversation.
        // Clearing this.abort marks that run superseded, so its catch/done
        // handlers stay silent instead of posting into the clean chat.
        this.abort?.abort();
        this.abort = undefined;
        this.resetHistory();
        this.post({ type: 'cleared' });
        this.postContext();
        break;
      case 'copied':
        this.services.log('Chat: code block copied.');
        break;
    }
  }

  private async run(text: string, mode: 'chat' | 'agent', kind?: TaskKind): Promise<void> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    this.post({ type: 'user', text: trimmed });
    this.abort?.abort();
    // Captured locally: by the time an aborted run reaches its catch block,
    // this.abort already belongs to the run that replaced it.
    const abort = new AbortController();
    this.abort = abort;

    if (mode === 'agent') {
      await this.runAgent(trimmed, abort);
      return;
    }

    this.history.push({ role: 'user', content: trimmed });
    try {
      const reply = await this.services.router.chat(this.history, {
        taskKind: kind ?? this.services.router.inferKind(trimmed),
        // The badge shows the model chat() actually routed to — a separate
        // pre-route here could disagree with it. Guarded so a New Chat during
        // the (async) model-detection window can't drop an empty bubble into
        // the cleared thread.
        onRouted: (model) => {
          if (this.abort === abort) {
            this.post({ type: 'assistantStart', model: model.id });
          }
        },
        onToken: (token) => this.post({ type: 'token', text: token }),
        signal: abort.signal,
      });
      this.history.push({ role: 'assistant', content: reply });
      this.post({ type: 'assistantDone', text: reply });
    } catch (error) {
      if (abort.signal.aborted && this.abort !== abort) {
        // Superseded by a newer run: posting anything here would clobber the
        // webview's stream state for the run that replaced this one.
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.post({
        type: 'error',
        interrupted: abort.signal.aborted,
        message: abort.signal.aborted
          ? 'Stopped.'
          : `Luigi could not reach a local model: ${message}. Start Ollama (\`ollama serve\`) or check luigi.model.endpoint.`,
      });
    }
  }

  private async runAgent(prompt: string, abort: AbortController): Promise<void> {
    this.post({ type: 'agentStart' });
    try {
      const result = await this.services.agent.execute({ prompt }, abort.signal);
      // A New Chat (which clears this.abort) supersedes this run — its result
      // must not repaint the cleared conversation.
      if (this.abort === abort) {
        this.post({ type: 'agentDone', success: result.success, summary: result.summary });
      }
    } catch (error) {
      if (this.abort !== abort) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.post({ type: 'agentDone', success: false, summary: `Agent run failed: ${message}` });
    }
  }

  private resetHistory(): void {
    const patterns = this.services.index.extractPatterns();
    const workspace = vscode.workspace.workspaceFolders?.[0]?.name ?? 'no workspace';
    this.history = [
      {
        role: 'system',
        content:
          'You are Luigi, an expert software engineer built by Luigi Solutions, running fully on the local machine. ' +
          `Workspace: ${workspace}. Dominant language: ${patterns.dominantLanguage || 'unknown'}. ` +
          'Be direct and concrete. Always put code in fenced blocks with a language tag. ' +
          'When modifying code, show complete replacements, not fragments.',
      },
    ];
  }

  private postContext(): void {
    const editor = vscode.window.activeTextEditor;
    const stats = this.services.index.stats;
    this.post({
      type: 'context',
      file: editor ? vscode.workspace.asRelativePath(editor.document.uri, false) : null,
      language: editor?.document.languageId ?? null,
      files: stats.fileCount,
      symbols: stats.symbolCount,
      model: this.services.router.statusSummary(),
      memory: this.services.memory.status,
    });
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed || !this.view) {
      return;
    }
    void this.view.webview.postMessage(message);
  }

  // ── Webview document ───────────────────────────────────────────────────────

  private _getHtmlContent(webview: vscode.Webview): string {
    const theme = vscode.workspace
      .getConfiguration('luigi')
      .get<LuigiTheme>('ui.theme', 'premium-black');
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.services.extensionUri, 'media', 'luigi-logo.svg')
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.services.extensionUri, 'media', 'luigi-icon.svg')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Luigi Codes</title>
<style>
  :root { ${cssVariables(theme)} }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--luigi-bg);
    color: var(--luigi-ink);
    font-family: var(--luigi-font-display);
    font-size: 13px;
    line-height: 1.6;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header: logo left, live model badge right ─────────────────────── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--luigi-border-subtle);
    background: var(--luigi-bg);
    flex: none;
  }
  header .logo { height: 22px; display: block; flex: none; }
  header .right { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .badge {
    font-size: 11px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    color: var(--luigi-gold);
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-sm);
    padding: 4px 8px;
    white-space: nowrap;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ghost-btn {
    background: none;
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-sm);
    color: var(--luigi-ink-muted);
    font-family: var(--luigi-font-display);
    font-size: 11px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    padding: 4px 8px;
    cursor: pointer;
    transition: color var(--luigi-duration-fast) var(--luigi-ease),
                border-color var(--luigi-duration-fast) var(--luigi-ease);
  }
  .ghost-btn:hover { color: var(--luigi-gold); border-color: var(--luigi-border-accent); }

  /* ── Context bar: where Luigi is looking ───────────────────────────── */
  #contextBar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    font-size: 11px;
    color: var(--luigi-ink-faint);
    border-bottom: 1px solid var(--luigi-border-subtle);
    background: var(--luigi-bg-secondary);
    flex: none;
    overflow: hidden;
    white-space: nowrap;
  }
  #contextBar .dot { color: var(--luigi-gold); }
  #contextBar span { flex: none; }
  /* Narrow panels: stats give way first, the file name second, never clip
     mid-character, always ellipsize. */
  #contextBar .ctx-file {
    color: var(--luigi-ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 6ch;
    flex: 0 1 auto;
  }
  #contextBar #ctxIndex {
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 4 auto;
  }

  /* Focus is the second border tier: full gold, the sole signal. */
  button:focus-visible, .chip:focus-visible {
    outline: 1px solid var(--luigi-gold);
    outline-offset: 2px;
  }

  /* ── Conversation ───────────────────────────────────────────────────── */
  main { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 24px 16px 8px; }
  main::-webkit-scrollbar { width: 8px; }
  main::-webkit-scrollbar-thumb { background: var(--luigi-bg-elevated); border-radius: var(--luigi-radius-md); }

  @keyframes reveal { from { opacity: 0; transform: translateY(1rem); } to { opacity: 1; transform: translateY(0); } }
  .reveal { animation: reveal var(--luigi-duration-slow) var(--luigi-ease) both; }

  /* Welcome */
  #welcome { max-width: 560px; margin: 8vh auto 0; text-align: center; }
  #welcome img.mark { width: 72px; height: 72px; margin-bottom: 16px; }
  #welcome .eyebrow {
    font-size: 11px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    color: var(--luigi-gold);
    margin-bottom: 12px;
  }
  #welcome h1 {
    font-family: var(--luigi-font-serif);
    font-weight: 400;
    font-size: 28px;
    color: var(--luigi-ink);
    margin-bottom: 8px;
  }
  #welcome p.sub { color: var(--luigi-ink-muted); font-size: 13px; margin-bottom: 24px; }
  #chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
  .chip {
    background: none;
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-sm);
    color: var(--luigi-ink-muted);
    font-family: var(--luigi-font-display);
    font-size: 12px;
    padding: 7px 14px;
    cursor: pointer;
    transition: all var(--luigi-duration-fast) var(--luigi-ease);
  }
  .chip:hover {
    color: var(--luigi-gold);
    border-color: var(--luigi-border-accent);
    box-shadow: var(--luigi-shadow-glow);
    transform: translateY(-1px);
  }
  .chip .chip-icon { color: var(--luigi-gold); margin-right: 6px; }

  /* Messages */
  .msg { margin-bottom: 24px; }
  .msg .who {
    font-size: 10px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .msg.user .who { color: var(--luigi-ink-faint); text-align: right; }
  .msg.assistant .who { color: var(--luigi-gold); }
  .msg.user .body {
    background: var(--luigi-bg-tertiary);
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-lg);
    border-top-right-radius: var(--luigi-radius-sm);
    padding: 12px 16px;
    margin-left: 15%;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg.assistant .body { color: var(--luigi-ink); word-break: break-word; }
  .msg.assistant .body.streaming { white-space: pre-wrap; }
  .msg.assistant .body h1, .msg.assistant .body h2,
  .msg.assistant .body h3, .msg.assistant .body h4 {
    font-family: var(--luigi-font-serif); font-weight: 500; margin: 16px 0 8px; color: var(--luigi-ink);
  }
  .msg.assistant .body h4 { font-size: 13px; }
  .msg.assistant .body p { margin: 8px 0; }
  .msg.assistant .body ul, .msg.assistant .body ol { margin: 8px 0 8px 20px; }
  .msg.assistant .body li { margin: 4px 0; }
  /* Bold stays ink: gold is an accent, not a highlighter for every emphasis. */
  .msg.assistant .body strong { color: var(--luigi-ink); font-weight: 600; }
  /* Links ARE interactive: gold is the right accent here. */
  .msg.assistant .body a {
    color: var(--luigi-gold);
    text-decoration: underline;
    text-underline-offset: 2px;
    text-decoration-color: var(--luigi-border-subtle);
  }
  .msg.assistant .body a:hover { color: var(--luigi-gold-light); text-decoration-color: var(--luigi-gold); }
  code.inline {
    font-family: var(--luigi-font-mono);
    font-size: 12px;
    background: var(--luigi-bg-tertiary);
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-sm);
    padding: 1px 4px;
    color: var(--luigi-ink);
  }
  .codeblock {
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-md);
    background: var(--luigi-bg-secondary);
    margin: 12px 0;
    overflow: hidden;
  }
  .codeblock .bar {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--luigi-border-subtle);
    font-size: 10px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    color: var(--luigi-ink-faint);
  }
  .codeblock .bar span {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .codeblock .bar button { flex: none; }
  .codeblock .bar button {
    background: none; border: none; cursor: pointer;
    color: var(--luigi-gold);
    font-family: var(--luigi-font-display);
    font-size: 10px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
  }
  .codeblock .bar button:hover { color: var(--luigi-gold-light); }
  .codeblock pre { padding: 12px; overflow-x: auto; }
  .codeblock pre::-webkit-scrollbar { height: 6px; }
  .codeblock pre::-webkit-scrollbar-thumb { background: var(--luigi-bg-elevated); }
  .codeblock code { font-family: var(--luigi-font-mono); font-size: 12px; color: var(--luigi-ink); }

  .error-msg {
    border: 1px solid var(--luigi-error);
    border-radius: var(--luigi-radius-md);
    color: var(--luigi-error);
    padding: 12px 16px;
    margin-bottom: 24px;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .stopped-note {
    color: var(--luigi-ink-faint);
    font-size: 11px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    margin-bottom: 24px;
  }

  /* Agent progress card */
  .agent-card {
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-md);
    background: var(--luigi-bg-secondary);
    padding: 16px;
    margin-bottom: 24px;
  }
  .agent-card .title {
    display: flex; align-items: center; gap: 8px;
    font-size: 11px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    color: var(--luigi-gold);
    margin-bottom: 12px;
  }
  /* Canonical loader cadence: the 3s gentle breathe, not a fast spin. */
  @keyframes spin { 0% { transform: rotate(0deg) scale(1); } 50% { transform: rotate(180deg) scale(1.05); } 100% { transform: rotate(360deg) scale(1); } }
  .spinner {
    width: 12px; height: 12px;
    border: 1.5px solid var(--luigi-gold-glow);
    border-top-color: var(--luigi-gold);
    border-radius: 50%;
    animation: spin 3s linear infinite;
  }
  .agent-card.done .spinner { display: none; }
  .agent-line { display: flex; gap: 8px; font-size: 12px; color: var(--luigi-ink-muted); padding: 2px 0; }
  .agent-line .ph { flex: none; color: var(--luigi-gold-dark); text-transform: uppercase; font-size: 10px; letter-spacing: var(--luigi-tracking-eyebrow); min-width: 62px; padding-top: 2px; }
  .agent-line span:last-child { min-width: 0; overflow-wrap: anywhere; }
  .agent-line.ok { color: var(--luigi-success); }
  .agent-line.bad { color: var(--luigi-error); }

  /* ── Composer ───────────────────────────────────────────────────────── */
  footer { flex: none; padding: 12px 16px 16px; border-top: 1px solid var(--luigi-border-subtle); background: var(--luigi-bg); }
  #composer {
    display: flex; align-items: flex-end; gap: 8px;
    border: 1px solid var(--luigi-border-subtle);
    border-radius: var(--luigi-radius-lg);
    background: var(--luigi-bg-secondary);
    padding: 8px 8px 8px 12px;
    transition: border-color var(--luigi-duration-fast) var(--luigi-ease),
                box-shadow var(--luigi-duration-fast) var(--luigi-ease);
  }
  #composer:focus-within { border-color: var(--luigi-border-accent); box-shadow: var(--luigi-shadow-glow); }
  #input {
    flex: 1;
    background: none; border: none; outline: none; resize: none;
    color: var(--luigi-ink);
    font-family: var(--luigi-font-display);
    font-size: 13px;
    line-height: 1.5;
    max-height: 160px;
  }
  #input::placeholder { color: var(--luigi-ink-faint); }
  #send {
    background: var(--luigi-gold);
    color: var(--luigi-bg);
    border: none;
    border-radius: var(--luigi-radius-md);
    width: 34px; height: 34px;
    font-size: 15px;
    cursor: pointer;
    flex: none;
    transition: all var(--luigi-duration-fast) var(--luigi-ease);
  }
  #send:hover { background: var(--luigi-gold-light); box-shadow: var(--luigi-shadow-glow-strong); }
  #send.stop { background: none; border: 1px solid var(--luigi-error); color: var(--luigi-error); }
  .mode-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; flex-wrap: wrap; gap: 8px; }
  #modeToggle { display: flex; gap: 0; border: 1px solid var(--luigi-border-subtle); border-radius: var(--luigi-radius-sm); overflow: hidden; }
  #modeToggle button {
    background: none; border: none; cursor: pointer;
    color: var(--luigi-ink-muted); /* functional control text, never ink-faint */
    font-family: var(--luigi-font-display);
    font-size: 10px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    padding: 4px 12px;
    transition: all var(--luigi-duration-fast) var(--luigi-ease);
  }
  #modeToggle button.active { background: var(--luigi-gold); color: var(--luigi-bg); }
  /* The container clips outward outlines: draw focus inside the control. */
  #modeToggle button:focus-visible { outline-offset: -2px; }
  /* Gold outline on the gold-filled active segment would be invisible. */
  #modeToggle button.active:focus-visible { outline-color: var(--luigi-bg); }
  .hint { font-size: 10px; color: var(--luigi-ink-faint); letter-spacing: var(--luigi-tracking-eyebrow); text-transform: uppercase; }

  /* Visually hidden live region for screen-reader announcements. */
  .sr-only {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .reveal { animation: none; }
    /* A frozen quarter-arc reads as a glitch: hide it; the send button's
       stop state still signals busy. */
    .spinner { display: none; }
    .chip:hover { transform: none; }
  }
</style>
</head>
<body>
  <header>
    <img class="logo" src="${logoUri}" alt="Luigi Codes" />
    <div class="right">
      <span class="badge" id="modelBadge">detecting models…</span>
      <button class="ghost-btn" id="newChat" title="Start a fresh conversation">New</button>
    </div>
  </header>

  <div id="contextBar">
    <span><span class="dot">●</span> local · private</span>
    <span class="ctx-file" id="ctxFile">no file focused</span>
    <span id="ctxIndex">index warming…</span>
  </div>

  <div id="srStatus" class="sr-only" role="status" aria-live="polite"></div>

  <main id="thread">
    <div id="welcome">
      <img class="mark reveal" src="${iconUri}" alt="" />
      <div class="eyebrow reveal" style="animation-delay: 80ms">Luigi Solutions · Private Local AI</div>
      <h1 class="reveal" style="animation-delay: 160ms">What are we building today?</h1>
      <p class="sub reveal" style="animation-delay: 240ms">Your code never leaves this machine.</p>
      <div id="chips" class="reveal" style="animation-delay: 320ms">
        <button class="chip" data-mode="chat" data-prompt="Explain what this codebase does and how it is structured."><span class="chip-icon">◆</span>Explain this codebase</button>
        <button class="chip" data-mode="chat" data-prompt="Review my currently open file for bugs and improvements."><span class="chip-icon">◆</span>Review open file</button>
        <button class="chip" data-mode="chat" data-prompt="Write unit tests for the function I have selected."><span class="chip-icon">◆</span>Generate tests</button>
        <button class="chip" data-mode="agent" data-prompt="Find TODO comments in this workspace and summarize what work remains."><span class="chip-icon">▸</span>Agent: scan TODOs</button>
        <button class="chip" data-mode="agent" data-prompt="Run the test suite and report what passes and fails."><span class="chip-icon">▸</span>Agent: run tests</button>
      </div>
    </div>
  </main>

  <footer>
    <div id="composer">
      <textarea id="input" rows="1" aria-label="Message Luigi" placeholder="Ask Luigi (Shift+Enter for a new line)"></textarea>
      <button id="send" title="Send">↑</button>
    </div>
    <div class="mode-row">
      <div id="modeToggle" role="group" aria-label="Response mode">
        <button id="modeChat" class="active" aria-pressed="true">Chat</button>
        <button id="modeAgent" aria-pressed="false">Agent</button>
      </div>
      <span class="hint">Runs entirely on your machine</span>
    </div>
  </footer>

<script nonce="${nonce}">
  var vscode = acquireVsCodeApi();
  var thread = document.getElementById('thread');
  var welcome = document.getElementById('welcome');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var modeChat = document.getElementById('modeChat');
  var modeAgent = document.getElementById('modeAgent');
  var mode = 'chat';
  var busy = false;
  var streamEl = null;
  var streamNode = null;
  var agentCard = null;
  var srStatus = document.getElementById('srStatus');

  // Follow the stream only while the reader is pinned to the bottom; a manual
  // scroll up releases the pin, scrolling back down (or sending) restores it.
  var pinned = true;
  thread.addEventListener('scroll', function () {
    pinned = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  });

  function announce(text) { srStatus.textContent = text; }

  // ── markdown helpers ──
  // Single source: src/chat/markdown.ts, injected as source so the panel
  // renders with the exact code the test suite exercises (esc/inline aliased
  // for the call sites below).
  ${escapeHtml.toString()}
  ${renderInline.toString()}
  ${renderMarkdown.toString()}
  var esc = escapeHtml;
  var inline = renderInline;

  // Welcome is detached (not destroyed) so New Chat can bring it back.
  function hideWelcome() {
    if (welcome && welcome.parentNode) { welcome.parentNode.removeChild(welcome); }
  }
  function showWelcome() {
    if (welcome && !welcome.parentNode) { thread.appendChild(welcome); }
  }
  function scrollDown(force) {
    if (force) { pinned = true; }
    if (pinned) { thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' }); }
  }

  function addMessage(role, label, bodyHtml) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role + ' reveal';
    wrap.innerHTML = '<div class="who">' + label + '</div><div class="body"></div>';
    wrap.querySelector('.body').innerHTML = bodyHtml;
    thread.appendChild(wrap);
    scrollDown(role === 'user');
    return wrap.querySelector('.body');
  }

  function setBusy(value) {
    busy = value;
    send.textContent = value ? '■' : '↑';
    send.className = value ? 'stop' : '';
    send.title = value ? 'Stop' : 'Send';
    send.setAttribute('aria-label', value ? 'Stop generating' : 'Send message');
  }

  // ── composer ──
  function autoresize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 160) + 'px';
  }
  input.addEventListener('input', autoresize);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  send.addEventListener('click', function () {
    if (busy) { vscode.postMessage({ type: 'stop' }); } else { submit(); }
  });
  function submit() {
    var text = input.value.trim();
    if (!text || busy) { return; }
    input.value = '';
    autoresize();
    vscode.postMessage({ type: 'send', text: text, mode: mode });
  }

  function setMode(next) {
    mode = next;
    modeChat.className = next === 'chat' ? 'active' : '';
    modeAgent.className = next === 'agent' ? 'active' : '';
    modeChat.setAttribute('aria-pressed', next === 'chat' ? 'true' : 'false');
    modeAgent.setAttribute('aria-pressed', next === 'agent' ? 'true' : 'false');
    input.placeholder = next === 'agent'
      ? 'Describe a task. Luigi plans, asks approval, then executes'
      : 'Ask Luigi (Shift+Enter for a new line)';
  }
  modeChat.addEventListener('click', function () { setMode('chat'); });
  modeAgent.addEventListener('click', function () { setMode('agent'); });

  document.getElementById('newChat').addEventListener('click', function () {
    vscode.postMessage({ type: 'newChat' });
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('copy')) {
      var codeEl = t.closest('.codeblock').querySelector('code');
      navigator.clipboard.writeText(codeEl.textContent).then(function () {
        t.textContent = 'Copied';
        setTimeout(function () { t.textContent = 'Copy'; }, 1500);
        vscode.postMessage({ type: 'copied' });
      }, function () {
        t.textContent = 'Failed';
        setTimeout(function () { t.textContent = 'Copy'; }, 1500);
      });
      return;
    }
    var chip = t && t.closest ? t.closest('.chip') : null;
    if (chip && !busy) {
      setMode(chip.getAttribute('data-mode') || 'chat');
      vscode.postMessage({ type: 'send', text: chip.getAttribute('data-prompt'), mode: mode });
      input.focus(); // the chip is about to leave the DOM with the welcome
    }
  });

  // ── agent progress ──
  var PHASES = ['context', 'plan', 'approve', 'execute', 'verify'];
  function ensureAgentCard() {
    if (agentCard) { return agentCard; }
    hideWelcome();
    var card = document.createElement('div');
    card.className = 'agent-card reveal';
    card.innerHTML = '<div class="title"><span class="spinner"></span><span>Luigi Agent</span></div><div class="lines"></div>';
    thread.appendChild(card);
    scrollDown();
    agentCard = card;
    return card;
  }
  function agentLine(phase, message, cls) {
    var card = ensureAgentCard();
    var line = document.createElement('div');
    line.className = 'agent-line' + (cls ? ' ' + cls : '');
    line.innerHTML = '<span class="ph">' + esc(phase) + '</span><span>' + esc(message) + '</span>';
    card.querySelector('.lines').appendChild(line);
    scrollDown();
  }

  // ── inbound from extension ──
  window.addEventListener('message', function (event) {
    var msg = event.data;
    switch (msg.type) {
      case 'context': {
        document.getElementById('ctxFile').textContent = msg.file ? msg.file : 'no file focused';
        document.getElementById('ctxIndex').textContent = msg.files + ' files · ' + msg.symbols + ' symbols · memory: ' + msg.memory;
        var badge = document.getElementById('modelBadge');
        badge.textContent = msg.model; badge.title = msg.model;
        break;
      }
      case 'user': {
        hideWelcome();
        addMessage('user', 'You', '<span></span>');
        thread.lastChild.querySelector('.body').textContent = msg.text;
        setBusy(true);
        break;
      }
      case 'assistantStart': {
        streamEl = addMessage('assistant', '🍄 Luigi · ' + esc(msg.model), '');
        streamEl.classList.add('streaming');
        // One text node, appended to: replacing textContent per token forces
        // a full re-layout of the whole message on every token.
        streamNode = document.createTextNode('');
        streamEl.appendChild(streamNode);
        break;
      }
      case 'token': {
        if (streamEl && streamNode) {
          streamNode.appendData(msg.text);
          scrollDown();
        }
        break;
      }
      case 'assistantDone': {
        if (streamEl) {
          streamEl.classList.remove('streaming');
          streamEl.innerHTML = renderMarkdown(msg.text);
          streamEl = null;
          streamNode = null;
        }
        setBusy(false);
        announce('Luigi finished replying.');
        scrollDown();
        break;
      }
      case 'agentStart': {
        agentCard = null;
        ensureAgentCard();
        setBusy(true);
        break;
      }
      case 'agentProgress': {
        var ev = msg.event;
        // Only append to a live card. After New Chat clears the thread
        // (agentCard = null), a late progress event must not resurrect a
        // zombie card into the fresh conversation. The 'done' phase is a
        // lifecycle marker; agentDone renders the real summary line.
        if (agentCard && PHASES.indexOf(ev.phase) > -1) {
          agentLine(ev.phase, ev.message, ev.level === 'error' ? 'bad' : ev.level === 'success' ? 'ok' : '');
        }
        break;
      }
      case 'agentDone': {
        if (agentCard) { agentCard.className = 'agent-card done'; }
        agentLine('done', msg.summary, msg.success ? 'ok' : 'bad');
        agentCard = null;
        setBusy(false);
        announce(msg.success ? 'Agent run complete.' : 'Agent run failed.');
        break;
      }
      case 'error': {
        hideWelcome();
        if (streamEl && !streamEl.textContent) {
          // Never received a token: drop the empty bubble, it's just noise.
          var emptyMsg = streamEl.closest('.msg');
          if (emptyMsg) { emptyMsg.parentNode.removeChild(emptyMsg); }
        } else if (streamEl) {
          // Partial reply (typically a Stop): finalize its markdown instead of
          // leaving raw fences and ** markers frozen on screen.
          streamEl.classList.remove('streaming');
          streamEl.innerHTML = renderMarkdown(streamEl.textContent);
        }
        var note = document.createElement('div');
        // A user-initiated stop is not a failure: style it as a quiet note.
        note.className = (msg.interrupted ? 'stopped-note' : 'error-msg') + ' reveal';
        note.textContent = msg.message;
        thread.appendChild(note);
        streamEl = null;
        streamNode = null;
        setBusy(false);
        announce(msg.message);
        scrollDown();
        break;
      }
      case 'cleared': {
        thread.innerHTML = '';
        agentCard = null;
        streamEl = null;
        streamNode = null;
        setBusy(false);
        showWelcome();
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
  input.focus();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString('hex');
}

// Re-exported so the design tokens travel with the chat surface for consumers
// that only import the UI layer.
export { LuigiBrand };
