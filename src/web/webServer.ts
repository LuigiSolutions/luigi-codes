/**
 * Luigi Codes — web app server.
 *
 * A zero-dependency `node:http` server that serves the Luigi chat as a
 * responsive web page — desktop browsers and phones alike — streaming from
 * the same local inference server the extension uses. The browser talks only
 * to this server; this server talks only to localhost inference. Nothing
 * leaves the machine (or, in LAN mode, the local network).
 *
 * This module MUST NOT import `vscode`: it also runs standalone via
 * `out/web/standalone.js` (`npm run web`) with no extension host at all.
 *
 * Security model: every request — page and API — must present the session
 * token (generated fresh per server start, compared in constant time). The
 * server binds 127.0.0.1 unless LAN mode is explicitly requested; in LAN mode
 * the token in the URL is the access key for phones on the same network.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { escapeHtml, renderInline, renderMarkdown } from '../chat/markdown';
import { ndjsonLines, parseSseChunk, splitAtStopMarker } from '../inference/streamText';
import { cssVariables, LuigiBrand, LuigiTheme } from '../ui/designTokens';

type Logger = (message: string) => void;

/** The two local-inference stream dialects Luigi speaks. */
export type WireFormat = 'ollama' | 'openai';

export interface WebServerConfig {
  /** Interface to bind. Default 127.0.0.1 (this machine only). */
  host?: string;
  /** Port to listen on. 0 lets the OS pick (used by tests). Default 8091. */
  port?: number;
  /** Base URL of the local inference server, e.g. http://localhost:8080. */
  modelEndpoint: string;
  /** Wire format the inference server speaks. */
  wire: WireFormat;
  /** Preferred model id. Empty → first model the server reports. */
  model?: string;
  /**
   * When true (the default), the configured endpoint is only the first
   * candidate: if it has no models, the well-known local servers are probed
   * too (Ollama :11434, LM Studio :1234, mlx-lm/llama.cpp :8080) and the
   * first one that answers wins. Chat then Just Works regardless of which
   * local stack the user runs. Tests pass false for determinism.
   */
  autoDetectModelServer?: boolean;
  theme?: LuigiTheme;
  /** Directory holding luigi-logo.svg / luigi-icon.svg to inline. Optional. */
  mediaDir?: string;
  log?: Logger;
}

/** A concrete inference server candidate. */
interface Backend {
  endpoint: string;
  wire: WireFormat;
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const MAX_BODY_BYTES = 2_000_000; // a whole conversation, with headroom
const MAX_MESSAGES = 200;

/** The public site allowed to poll /api/status (the Get Luigi Codes launcher). */
const SITE_ORIGIN = 'https://luigi-codes.vercel.app';

/** The local inference servers people actually run, probed in this order. */
const WELL_KNOWN_BACKENDS: Backend[] = [
  { endpoint: 'http://localhost:11434', wire: 'ollama' }, // Ollama
  { endpoint: 'http://localhost:1234', wire: 'openai' }, // LM Studio
  { endpoint: 'http://localhost:8080', wire: 'openai' }, // mlx-lm, llama.cpp
];

const SYSTEM_PROMPT =
  'You are Luigi, an expert software engineer built by Luigi Solutions, running fully on the local machine. ' +
  'Be direct and concrete. Always put code in fenced blocks with a language tag. ' +
  'When modifying code, show complete replacements, not fragments.';

export class LuigiWebServer {
  /** Per-start session token — the URL/API access key. */
  readonly token: string;

  private server: http.Server | undefined;
  private boundPort = 0;
  private startedUrls: string[] = [];

  constructor(private readonly config: WebServerConfig) {
    this.token = randomBytes(24).toString('hex');
  }

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number {
    return this.boundPort;
  }

  /** The URLs (with token) printed/shown after start(). */
  get urls(): string[] {
    return [...this.startedUrls];
  }

  async start(): Promise<{ port: number; urls: string[] }> {
    if (this.server) {
      return { port: this.boundPort, urls: this.urls };
    }
    const host = this.config.host ?? '127.0.0.1';
    const port = this.config.port ?? 8091;
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        this.log(`Web request failed: ${describe(error)}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        res.end('internal error');
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });

    this.server = server;
    const address = server.address();
    this.boundPort = typeof address === 'object' && address ? address.port : port;
    this.startedUrls = this.computeUrls(host);
    this.log(`Web app listening on ${host}:${this.boundPort} (${this.startedUrls.length} URL(s)).`);
    return { port: this.boundPort, urls: this.urls };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.log('Web app stopped.');
  }

  // ── Routing ────────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // CORS preflight (the luigi-codes.vercel.app launcher polls /api/status to
    // auto-open the app). Answered before auth: preflights carry no token.
    if (req.method === 'OPTIONS') {
      this.writeCors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
    if (!this.authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(this.unauthorizedPage());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(this.chatPage());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      this.writeCors(req, res);
      await this.handleStatus(res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      await this.handleChat(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }

  /**
   * Who gets in:
   * 1. Anyone presenting the session token (header or query), from anywhere.
   * 2. Same-machine requests (loopback socket) WITHOUT a token, provided the
   *    Host header is a loopback name. The Host check defeats DNS rebinding
   *    (a malicious site resolving its domain to 127.0.0.1 sends its own
   *    hostname in Host); the socket check means it is genuinely this machine.
   *    LAN/phone clients always need the token.
   */
  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const header = req.headers['x-luigi-token'];
    const presented =
      (typeof header === 'string' ? header : undefined) ?? url.searchParams.get('token') ?? '';
    if (presented.length > 0) {
      const a = Buffer.from(presented);
      const b = Buffer.from(this.token);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    return isLoopbackSocket(req) && isLoopbackHost(req.headers.host);
  }

  /** CORS for the public site's launcher: status polling only, no credentials. */
  private writeCors(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (origin !== SITE_ORIGIN) {
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-luigi-token');
    // Chrome Private Network Access: public https page probing a local server.
    if (req.headers['access-control-request-private-network'] === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
  }

  // ── API: status ────────────────────────────────────────────────────────────

  private async handleStatus(res: http.ServerResponse): Promise<void> {
    const { backend, models } = await this.detectBackend();
    const shown = backend ?? this.configuredBackend();
    const body = {
      endpoint: shown.endpoint,
      wire: shown.wire,
      model: this.resolveModel(models),
      reachable: models.length > 0,
      models,
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  // ── Model-server discovery ─────────────────────────────────────────────────

  /** The last backend that actually answered; probed first next time. */
  private active: Backend | undefined;

  private configuredBackend(): Backend {
    return { endpoint: this.config.modelEndpoint.replace(/\/$/, ''), wire: this.config.wire };
  }

  private candidates(): Backend[] {
    const list: Backend[] = [this.configuredBackend()];
    if (this.config.autoDetectModelServer !== false) {
      for (const candidate of WELL_KNOWN_BACKENDS) {
        if (!list.some((backend) => backend.endpoint === candidate.endpoint)) {
          list.push(candidate);
        }
      }
    }
    return list;
  }

  /**
   * Find a live inference server: sticky backend first, then the configured
   * endpoint, then the well-known local servers. Dead candidates refuse the
   * TCP connection in milliseconds, so a full miss is still fast.
   */
  private async detectBackend(): Promise<{ backend: Backend | undefined; models: string[] }> {
    const rest = this.candidates().filter((c) => c.endpoint !== this.active?.endpoint);
    const ordered = this.active ? [this.active, ...rest] : rest;
    for (const candidate of ordered) {
      const models = await this.probe(candidate);
      if (models.length > 0) {
        if (this.active?.endpoint !== candidate.endpoint) {
          this.log(`Model server found at ${candidate.endpoint} (${candidate.wire} wire).`);
        }
        this.active = candidate;
        return { backend: candidate, models };
      }
    }
    this.active = undefined;
    return { backend: undefined, models: [] };
  }

  private async probe(backend: Backend): Promise<string[]> {
    try {
      if (backend.wire === 'ollama') {
        const response = await fetch(`${backend.endpoint}/api/tags`, {
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
          return [];
        }
        const data = (await response.json()) as { models?: { name: string }[] };
        return (data.models ?? []).map((m) => m.name);
      }
      const response = await fetch(`${backend.endpoint}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  /** Configured model if the server has it (or nothing was detected); else first detected. */
  private resolveModel(models: string[]): string | null {
    const preferred = (this.config.model ?? '').trim();
    if (preferred.length > 0 && (models.length === 0 || models.includes(preferred))) {
      return preferred;
    }
    return models[0] ?? (preferred.length > 0 ? preferred : null);
  }

  // ── API: chat (SSE out, streaming from the local model) ───────────────────

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let parsed: { messages?: unknown };
    try {
      parsed = JSON.parse(await readBody(req)) as { messages?: unknown };
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: describe(error) }));
      return;
    }
    const messages = sanitizeMessages(parsed.messages);
    if (!messages) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body must be {"messages": [{role, content}, …]}' }));
      return;
    }
    if (messages[0]?.role !== 'system') {
      messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const send = (payload: Record<string, unknown>): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Phone locks / tab closes mid-stream: stop burning tokens upstream.
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const { backend, models } = await this.detectBackend();
    const model = this.resolveModel(models);
    if (!backend || !model) {
      send({
        error:
          'no local model server found. Start Ollama, LM Studio, or your custom server, then send again; Luigi reconnects automatically.',
      });
      res.end();
      return;
    }
    send({ model });
    try {
      await this.streamFromModel(backend, model, messages, (token) => send({ token }), abort.signal);
      send({ done: true });
    } catch (error) {
      if (!abort.signal.aborted) {
        send({ error: describe(error) });
      }
    }
    res.end();
  }

  private async streamFromModel(
    backend: Backend,
    model: string,
    messages: WireMessage[],
    onToken: (token: string) => void,
    signal: AbortSignal
  ): Promise<void> {
    const endpoint = backend.endpoint;
    if (backend.wire === 'ollama') {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
        signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      for await (const line of ndjsonLines(response.body)) {
        const chunk = JSON.parse(line) as { message?: { content?: string }; error?: string };
        if (chunk.error) {
          throw new Error(chunk.error);
        }
        const token = chunk.message?.content ?? '';
        if (token.length > 0) {
          onToken(token);
        }
      }
      return;
    }
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    for await (const line of ndjsonLines(response.body)) {
      if (line.startsWith(':')) {
        continue; // SSE keepalive comment
      }
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (payload === '' || payload === '[DONE]') {
        continue;
      }
      const chunk = parseSseChunk(payload);
      if (!chunk) {
        continue; // one malformed frame must not sink a good stream
      }
      if (chunk.error) {
        throw new Error(
          typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'stream error')
        );
      }
      const token = chunk.choices?.[0]?.delta?.content ?? '';
      if (token.length > 0) {
        const { text, stop } = splitAtStopMarker(token);
        if (text.length > 0) {
          onToken(text);
        }
        if (stop) {
          return; // leaked chat-template stop marker — the reply is complete
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private computeUrls(host: string): string[] {
    // Same-machine access is tokenless (loopback + Host check); only LAN URLs
    // carry the token, because remote clients have no other key.
    const tokenSuffix = `:${this.boundPort}/?token=${this.token}`;
    const local = `http://localhost:${this.boundPort}/`;
    if (host !== '0.0.0.0' && host !== '::') {
      return [host === '127.0.0.1' || host === 'localhost' ? local : `http://${host}${tokenSuffix}`];
    }
    const urls = [local];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list ?? []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          urls.push(`http://${iface.address}${tokenSuffix}`);
        }
      }
    }
    return urls;
  }

  private log(message: string): void {
    this.config.log?.(message);
  }

  /** Inline a brand SVG as a data URI, or undefined when media is unavailable. */
  private inlineSvg(name: string): string | undefined {
    if (!this.config.mediaDir) {
      return undefined;
    }
    try {
      const svg = fs.readFileSync(path.join(this.config.mediaDir, name), 'utf8');
      return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    } catch {
      return undefined;
    }
  }

  private unauthorizedPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Luigi Codes · locked</title>
<style>
  :root { ${cssVariables(this.config.theme ?? 'premium-black')} }
  body {
    background: var(--luigi-bg); color: var(--luigi-ink-muted);
    font-family: var(--luigi-font-display);
    display: flex; align-items: center; justify-content: center;
    height: 100vh; margin: 0; text-align: center; padding: 24px;
  }
  .eyebrow {
    font-size: 11px; letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase; color: var(--luigi-gold); margin-bottom: 12px;
  }
  h1 { font-family: var(--luigi-font-serif); font-weight: 400; color: var(--luigi-ink); }
</style>
</head>
<body>
  <div>
    <div class="eyebrow">Luigi Solutions · Private Local AI</div>
    <h1>This chat is token-locked.</h1>
    <p>Open the exact link Luigi printed when the web app started. It carries the access token.</p>
  </div>
</body>
</html>`;
  }

  // ── The chat page ──────────────────────────────────────────────────────────

  private chatPage(): string {
    const theme = this.config.theme ?? 'premium-black';
    const nonce = randomBytes(16).toString('hex');
    const logo = this.inlineSvg('luigi-logo.svg');
    const icon = this.inlineSvg('luigi-icon.svg');
    const logoHtml = logo
      ? `<img class="logo" src="${logo}" alt="Luigi Codes" />`
      : `<span class="wordmark">LUIGI CODES</span>`;
    const markHtml = icon ? `<img class="mark reveal" src="${icon}" alt="" />` : `<div class="mark reveal">🍄</div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self';">
<meta name="theme-color" content="${LuigiBrand.colors.background.primary}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🍄</text></svg>">
<title>Luigi Codes</title>
<style>
  :root { ${cssVariables(theme)} }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  html, body { height: 100%; }
  body {
    background: var(--luigi-bg);
    color: var(--luigi-ink);
    font-family: var(--luigi-font-display);
    font-size: 14px;
    line-height: 1.6;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
    border-bottom: 1px solid var(--luigi-border-subtle);
    background: var(--luigi-bg);
    flex: none;
  }
  header .logo { height: 22px; display: block; flex: none; }
  header .wordmark {
    font-family: var(--luigi-font-serif);
    letter-spacing: var(--luigi-tracking-wordmark);
    color: var(--luigi-ink);
    font-size: 14px;
  }
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
    max-width: 46vw;
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
    padding: 6px 10px;
    cursor: pointer;
    transition: color var(--luigi-duration-fast) var(--luigi-ease),
                border-color var(--luigi-duration-fast) var(--luigi-ease);
  }
  .ghost-btn:hover { color: var(--luigi-gold); border-color: var(--luigi-border-accent); }

  button:focus-visible, .chip:focus-visible {
    outline: 1px solid var(--luigi-gold);
    outline-offset: 2px;
  }

  /* ── Conversation ───────────────────────────────────────────────────── */
  main { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 24px 16px 8px; -webkit-overflow-scrolling: touch; }
  main::-webkit-scrollbar { width: 8px; }
  main::-webkit-scrollbar-thumb { background: var(--luigi-bg-elevated); border-radius: var(--luigi-radius-md); }
  .inner { max-width: 760px; margin: 0 auto; }

  @keyframes reveal { from { opacity: 0; transform: translateY(1rem); } to { opacity: 1; transform: translateY(0); } }
  .reveal { animation: reveal var(--luigi-duration-slow) var(--luigi-ease) both; }

  #welcome { max-width: 560px; margin: 10vh auto 0; text-align: center; }
  #welcome .mark { width: 72px; height: 72px; margin: 0 auto 16px; font-size: 56px; line-height: 72px; }
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
    padding: 8px 14px;
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
  .msg.assistant .body h4 { font-size: 14px; }
  .msg.assistant .body p { margin: 8px 0; }
  .msg.assistant .body ul, .msg.assistant .body ol { margin: 8px 0 8px 20px; }
  .msg.assistant .body li { margin: 4px 0; }
  .msg.assistant .body strong { color: var(--luigi-ink); font-weight: 600; }
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
  .codeblock .bar button {
    flex: none;
    background: none; border: none; cursor: pointer;
    color: var(--luigi-gold);
    font-family: var(--luigi-font-display);
    font-size: 10px;
    letter-spacing: var(--luigi-tracking-eyebrow);
    text-transform: uppercase;
    padding: 4px 0;
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

  /* ── Composer ───────────────────────────────────────────────────────── */
  footer {
    flex: none;
    padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--luigi-border-subtle);
    background: var(--luigi-bg);
  }
  footer .inner { max-width: 760px; margin: 0 auto; }
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
    font-size: 14px;
    line-height: 1.5;
    max-height: 160px;
  }
  #input::placeholder { color: var(--luigi-ink-faint); }
  #send {
    background: var(--luigi-gold);
    color: var(--luigi-bg);
    border: none;
    border-radius: var(--luigi-radius-md);
    width: 38px; height: 38px;
    font-size: 16px;
    cursor: pointer;
    flex: none;
    transition: all var(--luigi-duration-fast) var(--luigi-ease);
  }
  #send:hover { background: var(--luigi-gold-light); box-shadow: var(--luigi-shadow-glow-strong); }
  #send.stop { background: none; border: 1px solid var(--luigi-error); color: var(--luigi-error); }
  .mode-row { display: flex; align-items: center; justify-content: center; margin-top: 8px; }
  .hint { font-size: 10px; color: var(--luigi-ink-faint); letter-spacing: var(--luigi-tracking-eyebrow); text-transform: uppercase; }

  .sr-only {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }

  /* ── Small screens (phones) ─────────────────────────────────────────── */
  @media (max-width: 640px) {
    main { padding: 16px 12px 8px; }
    #welcome { margin-top: 5vh; }
    #welcome h1 { font-size: 24px; }
    .msg.user .body { margin-left: 8%; }
    .badge { max-width: 38vw; }
  }
  /* Touch devices: 16px input defeats iOS focus-zoom; bigger touch targets. */
  @media (pointer: coarse) {
    #input { font-size: 16px; }
    #send { width: 44px; height: 44px; }
    .chip { padding: 10px 16px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .reveal { animation: none; }
    .chip:hover { transform: none; }
  }
</style>
</head>
<body>
  <header>
    ${logoHtml}
    <div class="right">
      <span class="badge" id="modelBadge">checking model…</span>
      <button class="ghost-btn" id="newChat" title="Start a fresh conversation">New</button>
    </div>
  </header>

  <div id="srStatus" class="sr-only" role="status" aria-live="polite"></div>

  <main id="scroller">
    <div class="inner" id="thread">
      <div id="welcome">
        ${markHtml}
        <div class="eyebrow reveal" style="animation-delay: 80ms">Luigi Solutions · Private Local AI</div>
        <h1 class="reveal" style="animation-delay: 160ms">What are we building today?</h1>
        <p class="sub reveal" style="animation-delay: 240ms">Runs on your machine. Nothing leaves your network.</p>
        <div id="chips" class="reveal" style="animation-delay: 320ms">
          <button class="chip" data-prompt="Explain the difference between composition and inheritance, with TypeScript examples."><span class="chip-icon">◆</span>Teach me a concept</button>
          <button class="chip" data-prompt="Write a small, well-tested utility function I can paste into my project. Ask me what it should do first."><span class="chip-icon">◆</span>Write a utility</button>
          <button class="chip" data-prompt="Review this code for bugs and improvements: (paste your code after this message)"><span class="chip-icon">◆</span>Review my code</button>
          <button class="chip" data-prompt="Help me debug an error. I will paste the error message and the relevant code."><span class="chip-icon">◆</span>Debug an error</button>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <div class="inner">
      <div id="composer">
        <textarea id="input" rows="1" aria-label="Message Luigi" placeholder="Ask Luigi (Shift+Enter for a new line)"></textarea>
        <button id="send" title="Send">↑</button>
      </div>
      <div class="mode-row">
        <span class="hint" id="hint">local · private · your network only</span>
      </div>
    </div>
  </footer>

<script nonce="${nonce}">
  var TOKEN = '${this.token}';
  var scroller = document.getElementById('scroller');
  var thread = document.getElementById('thread');
  var welcome = document.getElementById('welcome');
  var input = document.getElementById('input');
  var send = document.getElementById('send');
  var srStatus = document.getElementById('srStatus');
  var messages = [];
  var busy = false;
  var controller = null;

  var pinned = true;
  scroller.addEventListener('scroll', function () {
    pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  });

  function announce(text) { srStatus.textContent = text; }

  // ── markdown helpers ──
  // Single source: src/chat/markdown.ts, injected as source so the web page
  // renders with the exact code the test suite exercises.
  ${escapeHtml.toString()}
  ${renderInline.toString()}
  ${renderMarkdown.toString()}
  var esc = escapeHtml;

  function hideWelcome() {
    if (welcome && welcome.parentNode) { welcome.parentNode.removeChild(welcome); }
  }
  function showWelcome() {
    if (welcome && !welcome.parentNode) { thread.appendChild(welcome); }
  }
  function scrollDown(force) {
    if (force) { pinned = true; }
    if (pinned) { scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' }); }
  }

  function addMessage(role, label) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + role + ' reveal';
    wrap.innerHTML = '<div class="who"></div><div class="body"></div>';
    wrap.querySelector('.who').textContent = label;
    thread.appendChild(wrap);
    scrollDown(role === 'user');
    return wrap.querySelector('.body');
  }

  function addNote(text, interrupted) {
    var note = document.createElement('div');
    note.className = (interrupted ? 'stopped-note' : 'error-msg') + ' reveal';
    note.textContent = text;
    thread.appendChild(note);
    scrollDown();
  }

  function setBusy(value) {
    busy = value;
    send.textContent = value ? '■' : '↑';
    send.className = value ? 'stop' : '';
    send.title = value ? 'Stop' : 'Send';
    send.setAttribute('aria-label', value ? 'Stop generating' : 'Send message');
  }

  // ── status badge ──
  function refreshStatus() {
    fetch('/api/status', { headers: { 'x-luigi-token': TOKEN } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        var badge = document.getElementById('modelBadge');
        badge.textContent = s.reachable ? s.model : 'model server offline';
        badge.title = s.endpoint + (s.model ? ' · ' + s.model : '');
      })
      .catch(function () {
        document.getElementById('modelBadge').textContent = 'status unavailable';
      });
  }
  refreshStatus();
  setInterval(refreshStatus, 60000);

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
    if (busy) { if (controller) { controller.abort(); } } else { submit(); }
  });
  function submit() {
    var text = input.value.trim();
    if (!text || busy) { return; }
    input.value = '';
    autoresize();
    ask(text);
  }

  document.getElementById('newChat').addEventListener('click', function () {
    if (controller) { controller.abort(); }
    messages = [];
    thread.innerHTML = '';
    setBusy(false);
    showWelcome();
  });

  // Copy buttons: clipboard API needs a secure context (not the case over
  // plain LAN http), so fall back to a selection-based copy.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.focus();
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) { resolve(); } else { reject(new Error('copy failed')); }
    });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains('copy')) {
      var codeEl = t.closest('.codeblock').querySelector('code');
      copyText(codeEl.textContent).then(function () {
        t.textContent = 'Copied';
        setTimeout(function () { t.textContent = 'Copy'; }, 1500);
      }, function () {
        t.textContent = 'Failed';
        setTimeout(function () { t.textContent = 'Copy'; }, 1500);
      });
      return;
    }
    var chip = t && t.closest ? t.closest('.chip') : null;
    if (chip && !busy) {
      ask(chip.getAttribute('data-prompt'));
    }
  });

  // ── the conversation ──
  function ask(text) {
    hideWelcome();
    var userBody = addMessage('user', 'You');
    userBody.textContent = text;
    messages.push({ role: 'user', content: text });
    setBusy(true);

    var streamEl = null;
    var streamNode = null;
    var reply = '';
    controller = new AbortController();
    var thisController = controller;

    fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-luigi-token': TOKEN },
      body: JSON.stringify({ messages: messages }),
      signal: thisController.signal
    }).then(function (response) {
      if (!response.ok || !response.body) { throw new Error('HTTP ' + response.status); }
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function handleLine(line) {
        if (line.indexOf('data:') !== 0) { return; }
        var payload;
        try { payload = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
        if (payload.model && !streamEl) {
          streamEl = addMessage('assistant', '🍄 Luigi · ' + payload.model);
          streamEl.classList.add('streaming');
          streamNode = document.createTextNode('');
          streamEl.appendChild(streamNode);
        } else if (payload.token) {
          if (streamNode) {
            reply += payload.token;
            streamNode.appendData(payload.token);
            scrollDown();
          }
        } else if (payload.error) {
          throw new Error(payload.error);
        }
      }

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) { return; }
          buffer += decoder.decode(result.value, { stream: true });
          var idx = buffer.indexOf('\\n');
          while (idx >= 0) {
            handleLine(buffer.slice(0, idx).trim());
            buffer = buffer.slice(idx + 1);
            idx = buffer.indexOf('\\n');
          }
          return pump();
        });
      }
      return pump();
    }).then(function () {
      finalize(null);
    }).catch(function (error) {
      finalize(error);
    });

    function finalize(error) {
      if (thisController !== controller) { return; } // superseded by New Chat
      var interrupted = thisController.signal.aborted;
      if (streamEl) {
        streamEl.classList.remove('streaming');
        if (reply.length > 0) {
          streamEl.innerHTML = renderMarkdown(reply);
          messages.push({ role: 'assistant', content: reply });
        } else {
          var emptyMsg = streamEl.closest('.msg');
          if (emptyMsg) { emptyMsg.parentNode.removeChild(emptyMsg); }
        }
      }
      if (interrupted) {
        addNote('Stopped.', true);
        announce('Stopped.');
      } else if (error) {
        addNote('Luigi could not reach the local model: ' + error.message, false);
        announce('Error: ' + error.message);
        refreshStatus();
      } else {
        announce('Luigi finished replying.');
      }
      controller = null;
      setBusy(false);
      scrollDown();
    }
  }

  input.focus();
</script>
</body>
</html>`;
  }
}

/** Read a request body with a hard size cap. */
function readBody(req: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Validate the browser's message array down to the exact wire shape. */
function sanitizeMessages(raw: unknown): WireMessage[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
    return undefined;
  }
  const out: WireMessage[] = [];
  for (const item of raw) {
    const message = item as { role?: unknown; content?: unknown };
    if (
      (message.role === 'system' || message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string'
    ) {
      out.push({ role: message.role, content: message.content });
    } else {
      return undefined;
    }
  }
  return out;
}

/** True when the TCP peer is this same machine. */
function isLoopbackSocket(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** True when the browser addressed a loopback name (DNS-rebinding guard). */
function isLoopbackHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
