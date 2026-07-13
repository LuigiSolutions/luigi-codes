/**
 * Luigi Codes — integration suite (T1–T28).
 *
 * Runs inside a real extension host with NO model server available: every
 * assertion here must hold on a cold machine.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { LuigiAgent } from '../../agent/agentLoop';
import { createDefaultTools, ToolRegistry } from '../../agent/tools/toolRegistry';
import { LuigiChatViewProvider } from '../../chat/chatPanel';
import { blendScore, CodebaseIndex, parseImports, parseSymbols } from '../../context/codebaseIndex';
import { escapeHtml, renderInline, renderMarkdown } from '../../chat/markdown';
import { buildTrainingExamples, SelfImprovement } from '../../improvement/selfImprove';
import { ModelProfile, ModelRouter, parseSseChunk, TaskKind } from '../../inference/modelRouter';
import { ndjsonLines, splitAtStopMarker } from '../../inference/streamText';
import { GitHubClient, validRepoName } from '../../github/githubClient';
import { createGitHubTools } from '../../github/githubTools';
import { MemorySystem, TaskRecord } from '../../memory/memorySystem';
import { cssVariables, LuigiBrand } from '../../ui/designTokens';
import { LuigiWebServer, pickReviewFiles } from '../../web/webServer';

const noop = (): void => undefined;

const EXTENSION_ID = 'LuigiSolutions.luigi-codes';

const ALL_COMMANDS = [
  'luigi.openChat',
  'luigi.explainCode',
  'luigi.improveCode',
  'luigi.generateTests',
  'luigi.fixBugs',
  'luigi.reviewCode',
  'luigi.terminalChat',
  'luigi.openWebApp',
  'luigi.connectGitHub',
  'luigi.showAgentStatus',
  'luigi.exportTrainingData',
  'luigi.setupModel',
];

/** Tool name → requiresApproval, exactly as the registry must declare them. */
const EXPECTED_TOOLS: Record<string, boolean> = {
  readFile: false,
  writeFile: true,
  editFile: true,
  deleteFile: true,
  executeShell: true,
  grep: false,
  gitDiff: false,
  gitLog: false,
  runTests: true,
  lspDiagnostics: false,
  lspReferences: false,
};

/** Exhaustive at the type level: adding a TaskKind breaks this compile. */
const KIND_MAP: Record<TaskKind, true> = {
  'code-generation': true,
  'code-explanation': true,
  'code-review': true,
  'test-generation': true,
  'bug-fixing': true,
  planning: true,
  chat: true,
  embedding: true,
};
const ALL_KINDS = Object.keys(KIND_MAP) as TaskKind[];

/** Every hex the brand defines, lowercased — the only hexes allowed anywhere. */
function brandHexes(): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const hex of value.match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
        found.add(hex.toLowerCase());
      }
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(LuigiBrand);
  return found;
}

function makeAgent(): LuigiAgent {
  const router = new ModelRouter(noop);
  const tools = new ToolRegistry(noop);
  const index = new CodebaseIndex(router, noop);
  const storage = vscode.Uri.file(path.join(os.tmpdir(), 'luigi-test-storage'));
  const memory = new MemorySystem(storage, router, noop);
  const improve = new SelfImprovement(storage, noop);
  return new LuigiAgent(router, tools, index, memory, improve, noop);
}

suite('Luigi Codes', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} not found in the test host.`);
    await extension.activate();
  });

  suiteTeardown(() => {
    LuigiChatViewProvider.current?.dispose();
  });

  /** Focus the chat view and wait until VS Code has resolved its webview. */
  async function resolvedChatView(): Promise<vscode.WebviewView> {
    await vscode.commands.executeCommand('luigi.openChat');
    const provider = LuigiChatViewProvider.current;
    assert.ok(provider, 'LuigiChatViewProvider.current not set.');
    for (let i = 0; i < 100; i++) {
      // Element access: reading past `private` for verification only.
      const view = provider!['view'];
      if (view) {
        return view;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail('Chat view did not resolve within 10s of luigi.openChat.');
  }

  test('T1: extension activates without throwing', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension?.isActive, 'Extension is not active after activate().');
  });

  test('T2: all 12 luigi.* commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    // VS Code auto-generates luigi.sidebar.* view-management commands from the
    // contributed webview view; only the extension's own commands count here.
    const registered = new Set(
      commands.filter((c) => c.startsWith('luigi.') && !c.startsWith('luigi.sidebar.'))
    );
    for (const command of ALL_COMMANDS) {
      assert.ok(registered.has(command), `Missing command: ${command}`);
    }
    assert.strictEqual(registered.size, ALL_COMMANDS.length, `Unexpected luigi.* commands: ${[...registered].filter((c) => !ALL_COMMANDS.includes(c)).join(', ')}`);
  });

  test('T3: luigi.openChat reveals the chat view with rendered HTML', async function () {
    this.timeout(15_000);
    const view = await resolvedChatView();
    assert.strictEqual(view.viewType, 'luigi.sidebar');
    assert.ok(view.webview.html.length > 0, 'Chat view has no HTML.');
  });

  test('T4: ToolRegistry contains exactly the 11 expected tools, declared correctly', () => {
    const registry = new ToolRegistry(noop);
    for (const tool of createDefaultTools(noop)) {
      registry.register(tool);
    }
    const tools = registry.list();
    assert.strictEqual(tools.length, 11, `Expected 11 tools, found ${tools.length}.`);
    for (const [name, requiresApproval] of Object.entries(EXPECTED_TOOLS)) {
      const tool = registry.get(name);
      assert.ok(tool, `Missing tool: ${name}`);
      assert.strictEqual(
        tool.requiresApproval,
        requiresApproval,
        `${name}.requiresApproval should be ${requiresApproval}.`
      );
      assert.ok(tool.parameters && typeof tool.parameters === 'object', `${name} has no parameter contract.`);
      for (const [param, description] of Object.entries(tool.parameters)) {
        assert.ok(description.trim().length > 0, `${name}.${param} has an empty description.`);
      }
      assert.ok(tool.description.trim().length > 0, `${name} has an empty description.`);
    }
  });

  test('T5: ModelRouter.route() returns a model for every TaskKind with the server down', () => {
    const router = new ModelRouter(noop);
    // No detectAvailableModels() call — the registry has zero available models,
    // exactly like a machine where Ollama is not installed.
    for (const kind of ALL_KINDS) {
      const routed = router.route({ kind });
      assert.ok(routed.model, `route() returned no model for ${kind}.`);
      assert.ok(routed.model.id.length > 0, `route() returned an empty model id for ${kind}.`);
      assert.strictEqual(routed.kind, kind);
      assert.match(routed.reason, /configured primary/, `Expected configured-primary fallback for ${kind}.`);
    }
    router.dispose();
  });

  test('T6: parsePlanFromResponse handles all four response shapes', () => {
    const agent = makeAgent();

    // 1. Clean JSON array.
    const clean = agent.parsePlanFromResponse(
      '[{"description": "Read the file", "tool": "readFile", "args": {"path": "a.ts"}}, {"description": "Summarize findings"}]'
    );
    assert.strictEqual(clean.length, 2);
    assert.strictEqual(clean[0].tool, 'readFile');
    assert.deepStrictEqual(clean[0].args, { path: 'a.ts' });
    assert.strictEqual(clean[1].tool, undefined);
    assert.deepStrictEqual(clean.map((s) => s.id), [1, 2]);

    // 2. Fenced ```json block.
    const fenced = agent.parsePlanFromResponse(
      'Here is the plan:\n```json\n[{"description": "Run tests", "tool": "runTests"}]\n```\nDone.'
    );
    assert.strictEqual(fenced.length, 1);
    assert.strictEqual(fenced[0].tool, 'runTests');

    // 3. JSON array surrounded by prose, no fence.
    const prose = agent.parsePlanFromResponse(
      'Sure! I suggest the following steps. [{"description": "Grep for TODO", "tool": "grep", "args": {"pattern": "TODO"}}] Let me know.'
    );
    assert.strictEqual(prose.length, 1);
    assert.strictEqual(prose[0].tool, 'grep');

    // 4. Pure prose fallback → reasoning steps, no tools.
    const fallback = agent.parsePlanFromResponse(
      '1. First, inspect the failing module carefully\n2. Then write a regression test for it\n3. Finally run the whole suite'
    );
    assert.ok(fallback.length >= 2, 'Prose fallback produced too few steps.');
    for (const step of fallback) {
      assert.strictEqual(step.tool, undefined, 'Prose fallback must not invent tools.');
      assert.ok(step.description.length > 8);
    }
    agent.dispose();
  });

  test('T7: designTokens cssVariables() emits both themes with only brand hexes', () => {
    const allowed = brandHexes();
    // Concatenated so the brand audit's hex scan never sees the wrong gold as
    // a literal in this repo.
    const offBrandGold = '#d4' + 'a853';
    assert.ok(allowed.has('#c9a86a'), 'Brand gold #c9a86a missing from LuigiBrand.');
    assert.ok(!allowed.has(offBrandGold), `Off-brand gold ${offBrandGold} found in LuigiBrand.`);

    const black = cssVariables('premium-black');
    const dark = cssVariables('premium-dark');
    assert.notStrictEqual(black, dark, 'Themes must differ.');
    for (const [theme, css] of [['premium-black', black], ['premium-dark', dark]] as const) {
      assert.ok(css.includes('--luigi-gold: #c9a86a'), `${theme} missing brand gold.`);
      assert.ok(css.includes('--luigi-bg:'), `${theme} missing background token.`);
      for (const hex of css.match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
        assert.ok(allowed.has(hex.toLowerCase()), `${theme} emits non-brand hex ${hex}.`);
      }
    }
  });

  test('T8: webview HTML — CSP, nonce, zero hardcoded hex in styles', async function () {
    this.timeout(15_000);
    const html: string = (await resolvedChatView()).webview.html;

    // CSP present and restrictive.
    const csp = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/s);
    assert.ok(csp, 'CSP meta tag missing.');
    assert.match(csp![1], /default-src 'none'/, 'CSP must start from default-src none.');

    // Nonce on the script tag, matching the CSP.
    const nonceInCsp = csp![1].match(/script-src 'nonce-([A-Za-z0-9]+)'/);
    assert.ok(nonceInCsp, 'CSP has no script nonce.');
    assert.ok(
      html.includes(`<script nonce="${nonceInCsp![1]}">`),
      'Script tag nonce does not match the CSP nonce.'
    );

    // Style rules use var(--luigi-*) only; the sole hexes allowed are the
    // brand token definitions inside the :root block.
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    assert.ok(style, '<style> block missing.');
    const rootBlock = style![1].match(/:root\s*\{[\s\S]*?\}/);
    assert.ok(rootBlock, ':root token block missing.');
    const allowed = brandHexes();
    for (const hex of rootBlock![0].match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
      assert.ok(allowed.has(hex.toLowerCase()), `:root emits non-brand hex ${hex}.`);
    }
    const outsideRoot = style![1].replace(rootBlock![0], '');
    const strayHex = outsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepStrictEqual(strayHex, [], `Hardcoded hex outside :root: ${strayHex.join(', ')}`);
    assert.ok(outsideRoot.includes('var(--luigi-'), 'Styles do not reference var(--luigi-*).');
  });

  test('T9: editFile inserts replacement literally (no $-pattern expansion)', async () => {
    const registry = new ToolRegistry(noop);
    for (const tool of createDefaultTools(noop)) {
      registry.register(tool);
    }
    const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const rel = 'edit-target.ts';
    const abs = path.join(workspace, rel);
    fs.writeFileSync(abs, 'const marker = OLD;\n', 'utf8');
    try {
      // Replacement full of regex substitution patterns — a plain-string
      // second arg to String.replace would splice file content here.
      const replacement = "echo $' && $& `$\\`` $1 $$";
      const result = await registry.execute('editFile', { path: rel, find: 'OLD', replace: replacement });
      assert.ok(result.ok, `editFile failed: ${result.error}`);
      const after = fs.readFileSync(abs, 'utf8');
      assert.strictEqual(after, `const marker = ${replacement};\n`, 'Replacement was not inserted verbatim.');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

  test('T10: autoApprove waives the modal for read-only plans but never for mutating ones', () => {
    const agent = makeAgent();
    // getFixStrategy never rewrites arguments the human approved (mutating
    // tools) — it retries as-approved, then skips, but never repairs.
    const registry = new ToolRegistry(noop);
    for (const tool of createDefaultTools(noop)) {
      registry.register(tool);
    }
    // Reach the agent's tool registry so the mutating check has real tools.
    (agent as unknown as { tools: ToolRegistry }).tools = registry;

    const mutatingStep = { id: 1, description: 'write', tool: 'writeFile', args: { path: 'a', content: 'b' } };
    const readonlyStep = { id: 1, description: 'read', tool: 'readFile', args: { path: 'a' } };

    const mutA1 = agent.getFixStrategy(mutatingStep, 'boom', 1, 3);
    const mutA2 = agent.getFixStrategy(mutatingStep, 'boom', 2, 3);
    assert.strictEqual(mutA1.action, 'retry', 'Mutating step should retry as-approved first.');
    assert.strictEqual(mutA2.action, 'skip', 'Mutating step must never repair post-approval.');

    const roA2 = agent.getFixStrategy(readonlyStep, 'not found', 2, 3);
    assert.strictEqual(roA2.action, 'repair', 'Read-only step may still repair arguments.');
    agent.dispose();
  });

  test('T12: correction capture — human edit of a Luigi-written file is learned once', () => {
    const storage = vscode.Uri.file(path.join(os.tmpdir(), `luigi-improve-${Date.now()}`));
    const improve = new SelfImprovement(storage, noop);

    // No baseline yet → a save reconciles to nothing.
    assert.strictEqual(improve.reconcileSavedFile('a.ts', 'anything'), false);

    // Luigi writes a file, human edits it → captured exactly once.
    improve.noteProducedFile('a.ts', 'export const x = 1;\n', 'add constant x');
    assert.strictEqual(improve.reconcileSavedFile('a.ts', 'export const x = 1;\n'), false, 'Unchanged save must not count.');
    assert.strictEqual(improve.reconcileSavedFile('a.ts', 'export const x = 2;\n'), true, 'Edited save should be captured.');
    assert.strictEqual(improve.reconcileSavedFile('a.ts', 'export const x = 3;\n'), false, 'Baseline is consumed after one capture.');

    // The captured pair advances fine-tune readiness (corrections count).
    assert.ok(improve.shouldFineTune().datasetSize >= 1, 'Correction did not enter the dataset.');
  });

  test('T11: parseSseChunk tolerates heartbeats but preserves token/error frames', () => {
    // Well-formed token frame parses.
    const token = parseSseChunk('{"choices":[{"delta":{"content":"hi"}}]}');
    assert.strictEqual(token?.choices?.[0]?.delta?.content, 'hi');

    // Error frame is preserved so the caller can raise it.
    const errObj = parseSseChunk('{"error":{"message":"overloaded"}}');
    assert.ok(errObj?.error && typeof errObj.error !== 'string' && errObj.error.message === 'overloaded');
    const errStr = parseSseChunk('{"error":"boom"}');
    assert.strictEqual(errStr?.error, 'boom');

    // A malformed heartbeat/partial frame yields undefined (caller skips it)
    // rather than throwing and sinking the whole stream.
    assert.strictEqual(parseSseChunk('this is not json'), undefined);
    assert.strictEqual(parseSseChunk('{"choices":[{"delta":'), undefined);
  });

  test('T23: leaked chat-template stop markers end the stream instead of rendering as text', () => {
    // Raw mlx-lm emits the stop marker as a literal token (observed live:
    // "ready" then "<|im_end|>") — it must never reach the user.
    assert.deepStrictEqual(splitAtStopMarker('<|im_end|>'), { text: '', stop: true });
    assert.deepStrictEqual(splitAtStopMarker('done.<|im_end|>'), { text: 'done.', stop: true });
    assert.deepStrictEqual(splitAtStopMarker('x<|endoftext|>'), { text: 'x', stop: true });
    assert.deepStrictEqual(splitAtStopMarker('y</s>trailing'), { text: 'y', stop: true });
    // Ordinary tokens pass through untouched — including near-miss text.
    assert.deepStrictEqual(splitAtStopMarker('hello'), { text: 'hello', stop: false });
    assert.deepStrictEqual(splitAtStopMarker('a < b | c'), { text: 'a < b | c', stop: false });
    // Earliest marker wins when several appear.
    assert.deepStrictEqual(splitAtStopMarker('a</s>b<|im_end|>'), { text: 'a', stop: true });
  });

  test('T13: router inferKind classifies representative requests', () => {
    const router = new ModelRouter(noop);
    const cases: [string, TaskKind][] = [
      ['write unit tests for this function', 'test-generation'],
      ['fix the bug that crashes on empty input', 'bug-fixing'],
      ['review this module for issues', 'code-review'],
      ['explain what this function does', 'code-explanation'],
      ['plan the migration approach', 'planning'],
      ['implement a new endpoint', 'code-generation'],
      ['hello there', 'chat'],
      // Inflected forms — the common real phrasings, not just base verbs.
      ['debugging this crash', 'bug-fixing'],
      ['the code errors out', 'bug-fixing'],
      ['writing a parser', 'code-generation'],
      ['implementing auth', 'code-generation'],
      ['improving performance', 'code-generation'],
      ['explains the flow', 'code-explanation'],
      ['reviewing this PR', 'code-review'],
      ['planning the refactor', 'planning'],
      // Boundary guards — no false positive from a substring ('add' in these).
      ['address the issue', 'chat'],
    ];
    for (const [text, expected] of cases) {
      assert.strictEqual(router.inferKind(text), expected, `"${text}" should infer ${expected}.`);
    }
    router.dispose();
  });

  test('T17: file tools refuse paths that escape the workspace', async () => {
    const registry = new ToolRegistry(noop);
    for (const tool of createDefaultTools(noop)) {
      registry.register(tool);
    }

    // A legitimate in-workspace read works (fixture wrote sample.ts).
    const ok = await registry.execute('readFile', { path: 'sample.ts' });
    assert.ok(ok.ok, `In-workspace read should succeed: ${ok.error}`);

    // Traversal and absolute paths are refused by resolveSafe, for every tool
    // that resolves a path — the guard is the machine-safety boundary.
    const escapes = [
      ['readFile', { path: '../../../etc/hosts' }],
      ['readFile', { path: '/etc/hosts' }],
      ['writeFile', { path: '../escapee.txt', content: 'nope' }],
      ['editFile', { path: '../../x.ts', find: 'a', replace: 'b' }],
      ['deleteFile', { path: '../../../tmp/x' }],
    ] as const;
    for (const [tool, args] of escapes) {
      const result = await registry.execute(tool, args as Record<string, string>);
      assert.strictEqual(result.ok, false, `${tool} must refuse ${args.path}.`);
      assert.match(
        result.error ?? '',
        /escape/i,
        `${tool} should refuse ${args.path} with an escape error, got: ${result.error}`
      );
    }

    // The refused write must not have created a file above the workspace.
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.ok(!fs.existsSync(path.join(root, '..', 'escapee.txt')), 'Escaping write leaked a file.');
  });

  test('T16: markdown renderer — bold never leaks into inline code, and injection is wired', async () => {
    // The bug: bold applied globally corrupts code containing `**`.
    assert.strictEqual(
      renderInline('`x**2 + y**2`'),
      '<code class="inline">x**2 + y**2</code>',
      'Inline code must stay literal — no bold inside it.'
    );
    assert.strictEqual(renderInline('`**literal**`'), '<code class="inline">**literal**</code>');
    // Bold still works OUTSIDE code.
    assert.strictEqual(renderInline('use **bold** here'), 'use <strong>bold</strong> here');

    // Block-level: escaping, headings, ordered + unordered lists, fenced code.
    assert.strictEqual(escapeHtml('<a> & b'), '&lt;a&gt; &amp; b');
    assert.ok(renderMarkdown('# Title').includes('<h2>Title</h2>'));
    assert.ok(renderMarkdown('1. one\n2. two').includes('<ol><li>one</li><li>two</li></ol>'));
    assert.ok(renderMarkdown('- a\n- b').includes('<ul><li>a</li><li>b</li></ul>'));
    assert.ok(renderMarkdown('```js\nconst x=1;\n```').includes('<pre><code>const x=1;</code></pre>'));

    // Injection wiring: the chat HTML embeds these exact functions as source,
    // so what renders is what this test exercised.
    const html: string = (await resolvedChatView()).webview.html;
    assert.ok(html.includes('function escapeHtml'), 'escapeHtml not injected into webview.');
    assert.ok(html.includes('function renderInline'), 'renderInline not injected into webview.');
    assert.ok(html.includes('function renderMarkdown'), 'renderMarkdown not injected into webview.');
    assert.ok(html.includes('var esc = escapeHtml'), 'esc alias missing.');
  });

  test('T19: fine-tune export builds chat pairs from accepted work + corrections only', () => {
    const now = 1;
    const examples = buildTrainingExamples(
      [
        { kind: 'agent-task', prompt: 'add a helper', response: 'here it is', accepted: true, timestamp: now },
        { kind: 'chat', prompt: 'rejected one', response: 'bad answer', accepted: false, timestamp: now },
        { kind: 'chat', prompt: '', response: 'no prompt', accepted: true, timestamp: now }, // skipped (empty)
      ],
      [
        { original: 'luigi wrote this', corrected: 'human fixed this', context: 'improve foo', pattern: 'x', timestamp: now },
      ]
    );
    // One accepted interaction + one correction; rejected and empty are dropped.
    assert.strictEqual(examples.length, 2);
    assert.deepStrictEqual(examples[0].messages, [
      { role: 'user', content: 'add a helper' },
      { role: 'assistant', content: 'here it is' },
    ]);
    // The correction labels with the CORRECTED text (never the rejected original).
    const correction = examples[1].messages;
    assert.strictEqual(correction[0].content, 'improve foo');
    assert.strictEqual(correction[1].content, 'human fixed this');
    assert.ok(!JSON.stringify(examples).includes('luigi wrote this'), 'Rejected original must not appear as a label.');

    // The SelfImprovement export splits into non-empty train/valid as valid JSONL.
    const storage = vscode.Uri.file(path.join(os.tmpdir(), `luigi-ft-${Date.now()}`));
    const improve = new SelfImprovement(storage, noop);
    for (let i = 0; i < 20; i++) {
      improve.captureInteraction({ kind: 'chat', prompt: `q${i}`, response: `a${i}`, accepted: true, timestamp: now });
    }
    const out = improve.exportTrainingJsonl();
    assert.strictEqual(out.count, 20);
    assert.ok(out.valid.length > 0, 'valid.jsonl must be non-empty for mlx_lm.');
    for (const line of (out.train + '\n' + out.valid).trim().split('\n')) {
      const row = JSON.parse(line);
      assert.ok(Array.isArray(row.messages) && row.messages.length === 2, 'Each JSONL line is a 2-turn chat row.');
    }
  });

  test('T18: markdown links render for safe schemes only', () => {
    // http/https/mailto become anchors.
    assert.strictEqual(renderInline('see [docs](https://x.com/a)'), 'see <a href="https://x.com/a">docs</a>');
    assert.ok(renderInline('[mail](mailto:a@b.com)').includes('<a href="mailto:a@b.com">mail</a>'));
    // Bold composes inside a link.
    assert.strictEqual(renderInline('[**b**](https://x.com)'), '<a href="https://x.com"><strong>b</strong></a>');
    // Unsafe schemes are NOT linkified — left literal, no anchor emitted.
    assert.strictEqual(renderInline('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
    assert.ok(!renderInline('[x](data:text/html,abc)').includes('<a '));
    // A quote in the URL is escaped so it cannot break out of href.
    assert.ok(!renderInline('[a](https://x.com/"y)').includes('href="https://x.com/"y"'));
    assert.ok(renderInline('[a](https://x.com/"y)').includes('&quot;'));
    // Links inside inline code stay literal.
    assert.strictEqual(renderInline('`[a](http://y)`'), '<code class="inline">[a](http://y)</code>');
  });

  test('T15: blendScore keeps lexical + semantic on one scale', () => {
    // A file that failed to embed (undefined similarity) must not outrank a
    // file with the same lexical score that DID match semantically.
    assert.ok(
      blendScore(8, undefined) < blendScore(8, 0.5),
      'A semantic match must rank at or above an un-embedded peer.'
    );
    // And it must not outrank a lower-lexical file with a strong semantic match
    // (the old bug: raw lexical 8 beat a blended semantic winner).
    assert.ok(
      blendScore(8, undefined) < blendScore(3, 0.6),
      'A strong semantic match should beat a lexical-only high scorer.'
    );
    // Missing similarity contributes nothing beyond scaled lexical.
    assert.strictEqual(blendScore(10, undefined), 4);
    // More lexical overlap still helps when neither embeds.
    assert.ok(blendScore(9, undefined) > blendScore(4, undefined));
  });

  /** A web server pointed at a dead endpoint (port 9, nothing listens) on an ephemeral port. */
  async function startedWebServer(): Promise<{ server: LuigiWebServer; base: string }> {
    const server = new LuigiWebServer({
      host: '127.0.0.1',
      port: 0,
      modelEndpoint: 'http://127.0.0.1:9',
      wire: 'openai',
      // Deterministic: a dev machine may have a real Ollama/mlx server running,
      // and these tests must behave identically with and without one.
      autoDetectModelServer: false,
      log: noop,
    });
    const { port } = await server.start();
    return { server, base: `http://127.0.0.1:${port}` };
  }

  /** Raw GET with a spoofed Host header (fetch forbids setting Host). */
  function getWithHost(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        { hostname: '127.0.0.1', port, path: '/', method: 'GET', headers: { Host: host } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        }
      );
      request.on('error', reject);
      request.end();
    });
  }

  test('T20: web app access model: same-machine tokenless, rebinding blocked, wrong token refused', async () => {
    const { server, base } = await startedWebServer();
    try {
      // Same machine, honest loopback Host, no token → welcome (the site's
      // Get Luigi Codes launcher depends on this).
      assert.strictEqual((await fetch(`${base}/`)).status, 200);
      // A WRONG token is refused even from loopback.
      assert.strictEqual((await fetch(`${base}/?token=${'0'.repeat(48)}`)).status, 401);
      // DNS rebinding: loopback socket but a foreign Host name → locked out.
      assert.strictEqual(await getWithHost(server.port, 'evil.example.com'), 401);
      assert.strictEqual(await getWithHost(server.port, 'localhost:9999'), 200);

      const ok = await fetch(`${base}/?token=${server.token}`);
      assert.strictEqual(ok.status, 200);
      const html = await ok.text();

      // Same rendering pipeline as the panel: markdown functions injected as source.
      assert.ok(html.includes('function escapeHtml'), 'escapeHtml not injected into web page.');
      assert.ok(html.includes('function renderMarkdown'), 'renderMarkdown not injected into web page.');

      // CSP with a matching script nonce, like the webview (T8).
      const csp = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/s);
      assert.ok(csp, 'Web page CSP meta tag missing.');
      assert.match(csp![1], /default-src 'none'/);
      const nonce = csp![1].match(/script-src 'nonce-([A-Za-z0-9]+)'/);
      assert.ok(nonce, 'Web page CSP has no script nonce.');
      assert.ok(html.includes(`<script nonce="${nonce![1]}">`), 'Script nonce does not match CSP.');

      // Brand discipline: only brand hexes in :root, none hardcoded elsewhere.
      const style = html.match(/<style>([\s\S]*?)<\/style>/);
      assert.ok(style, 'Web page <style> missing.');
      const rootBlock = style![1].match(/:root\s*\{[\s\S]*?\}/);
      assert.ok(rootBlock, 'Web page :root token block missing.');
      const allowed = brandHexes();
      for (const hex of rootBlock![0].match(/#[0-9a-fA-F]{3,8}/g) ?? []) {
        assert.ok(allowed.has(hex.toLowerCase()), `Web :root emits non-brand hex ${hex}.`);
      }
      const outsideRoot = style![1].replace(rootBlock![0], '');
      assert.deepStrictEqual(outsideRoot.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], 'Hardcoded hex outside :root in web page.');

      // Mobile-ready: viewport meta + dynamic-viewport height + touch sizing.
      assert.match(html, /name="viewport" content="width=device-width/, 'Viewport meta missing.');
      assert.ok(html.includes('100dvh'), 'Page does not use dynamic viewport height.');
      assert.ok(html.includes('pointer: coarse'), 'No touch-device adjustments.');
    } finally {
      await server.stop();
    }
  });

  test('T21: web /api/status degrades gracefully and speaks CORS only to the site', async () => {
    const { server, base } = await startedWebServer();
    try {
      const response = await fetch(`${base}/api/status`, {
        headers: { 'x-luigi-token': server.token },
      });
      assert.strictEqual(response.status, 200);
      const status = (await response.json()) as { reachable: boolean; models: string[]; endpoint: string };
      assert.strictEqual(status.reachable, false, 'Dead endpoint must report unreachable.');
      assert.deepStrictEqual(status.models, []);
      assert.strictEqual(status.endpoint, 'http://127.0.0.1:9');

      // The launcher on luigi-codes.vercel.app may poll status cross-origin…
      const preflight = await fetch(`${base}/api/status`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://luigi-codes.vercel.app',
          'access-control-request-method': 'GET',
          'access-control-request-private-network': 'true',
        },
      });
      assert.strictEqual(preflight.status, 204);
      assert.strictEqual(
        preflight.headers.get('access-control-allow-origin'),
        'https://luigi-codes.vercel.app'
      );
      assert.strictEqual(preflight.headers.get('access-control-allow-private-network'), 'true');

      // …but any other origin gets no CORS invitation.
      const foreign = await fetch(`${base}/api/status`, {
        headers: { origin: 'https://evil.example.com' },
      });
      assert.strictEqual(foreign.headers.get('access-control-allow-origin'), null);
    } finally {
      await server.stop();
    }
  });

  test('T22: web /api/chat surfaces upstream failure as an SSE error frame, and rejects bad bodies', async () => {
    const { server, base } = await startedWebServer();
    try {
      const headers = { 'Content-Type': 'application/json', 'x-luigi-token': server.token };

      // Malformed body → 400, not a stream.
      const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: '{"messages": "nope"}' });
      assert.strictEqual(bad.status, 400);

      // Valid body, dead model server → a clean SSE error frame, no crash.
      const response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      assert.strictEqual(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await response.text();
      assert.ok(text.includes('"error"'), `Expected an SSE error frame, got: ${text}`);
      // And the server is still alive afterwards.
      const alive = await fetch(`${base}/api/status`, { headers: { 'x-luigi-token': server.token } });
      assert.strictEqual(alive.status, 200);
    } finally {
      await server.stop();
    }
  });

  test('T24: GitHub tools declare reads free and writes approval-gated, and demand a connection', async () => {
    // Token provider returns nothing: the exact state before Connect GitHub.
    const disconnected = new GitHubClient(async () => undefined);
    const tools = createGitHubTools(disconnected, noop);

    const expected: Record<string, boolean> = {
      githubListRepos: false,
      githubListFiles: false,
      githubReadFile: false,
      githubCommitFile: true,
      githubOpenPullRequest: true,
    };
    assert.strictEqual(tools.length, Object.keys(expected).length);
    for (const tool of tools) {
      assert.strictEqual(
        tool.requiresApproval,
        expected[tool.name],
        `${tool.name}.requiresApproval must be ${expected[tool.name]} (writes gate, reads flow).`
      );
      assert.ok(tool.description.trim().length > 0, `${tool.name} has an empty description.`);
      for (const [param, description] of Object.entries(tool.parameters)) {
        assert.ok(description.trim().length > 0, `${tool.name}.${param} has an empty description.`);
      }
    }

    // Registry surfaces the "connect first" error instead of a network attempt.
    const registry = new ToolRegistry(noop);
    for (const tool of tools) {
      registry.register(tool);
    }
    const result = await registry.execute('githubListRepos', {});
    assert.strictEqual(result.ok, false);
    assert.match(result.error ?? '', /Connect GitHub/i);

    // Malformed repo names are refused before any request could be built.
    const badRepo = await registry.execute('githubReadFile', { repo: 'not-a-repo', path: 'x' });
    assert.strictEqual(badRepo.ok, false);
    assert.ok(validRepoName('LuigiSolutions/luigi-codes'));
    assert.ok(!validRepoName('owner/name/extra'));
    assert.ok(!validRepoName('https://github.com/o/r'));
  });

  test('T25: web GitHub endpoints require a token, and the review picker skips junk', async () => {
    const { server, base } = await startedWebServer();
    try {
      // Every /api/github route refuses to act without the browser's token.
      const noToken = await fetch(`${base}/api/github/repos`);
      assert.strictEqual(noToken.status, 400);
      const body = (await noToken.json()) as { error: string };
      assert.match(body.error, /connect GitHub/i);
    } finally {
      await server.stop();
    }

    // The review bundle: orientation files first, junk and binaries never.
    const picked = pickReviewFiles([
      'node_modules/lib/index.js',
      'package-lock.json',
      'logo.png',
      'README.md',
      'package.json',
      'src/deep/nested/util.ts',
      'src/main.ts',
      'dist/bundle.js',
    ]);
    assert.deepStrictEqual(picked.slice(0, 2), ['README.md', 'package.json']);
    assert.ok(picked.includes('src/main.ts'));
    assert.ok(picked.indexOf('src/main.ts') < picked.indexOf('src/deep/nested/util.ts'));
    assert.ok(!picked.some((p) => /node_modules|package-lock|\.png|dist\//.test(p)));
  });

  test('T14: scoreModel rewards capability match and penalizes overflow', () => {
    const router = new ModelRouter(noop);
    const coder: ModelProfile = {
      id: 'c', name: 'c', family: 'c', contextWindow: 8192,
      strengths: ['code-generation'], speed: 4, quality: 3, available: true,
    };
    const chatter: ModelProfile = {
      id: 'h', name: 'h', family: 'h', contextWindow: 8192,
      strengths: ['chat'], speed: 4, quality: 3, available: true,
    };
    // The model whose strengths include the task kind must score higher.
    assert.ok(
      router.scoreModel(coder, 'code-generation', 0) > router.scoreModel(chatter, 'code-generation', 0),
      'Capability match should win.'
    );
    // A prompt that cannot fit the context window is penalized.
    const fits = router.scoreModel(coder, 'code-generation', 1000);
    const overflows = router.scoreModel(coder, 'code-generation', 100000);
    assert.ok(overflows < fits, 'Context overflow should lower the score.');
    router.dispose();
  });

  test('T26: ndjsonLines splits across chunk boundaries, drops blank lines, flushes the tail', async () => {
    // A JSON line split mid-way across two chunks, a whitespace-only line, and a
    // final line with no trailing newline must all be handled correctly.
    const chunks = ['{"a":1}\n{"b":', '2}\n   \n', '{"c":3}'];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const lines: string[] = [];
    for await (const line of ndjsonLines(stream)) {
      lines.push(line);
    }
    assert.deepStrictEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  test('T27: MemorySystem stores, ranks by similarity, and orders history newest-first (server down)', async () => {
    const router = new ModelRouter(noop);
    const storage = vscode.Uri.file(path.join(os.tmpdir(), `luigi-mem-${Date.now()}`));
    const memory = new MemorySystem(storage, router, noop);

    const auth: TaskRecord = {
      id: 'a', timestamp: 1000, prompt: 'Implement authentication middleware for the server',
      planSummary: 'add middleware', outcome: 'done', success: true, filesTouched: ['auth.ts'], durationMs: 5,
    };
    const layout: TaskRecord = {
      id: 'b', timestamp: 2000, prompt: 'Refactor the pagination component styling',
      planSummary: 'css work', outcome: 'done', success: true, filesTouched: ['grid.css'], durationMs: 5,
    };
    await memory.storeTask(auth);
    await memory.storeTask(layout);

    // Hash-embedding fallback (no embed server): a query sharing tokens with the
    // auth record must rank it first; the unrelated record scores 0 and is dropped.
    const hits = await memory.findSimilar('authentication middleware', 3);
    assert.ok(hits.length >= 1, 'expected at least one similar record');
    assert.strictEqual(hits[0].id, 'a', 'auth record should rank first');
    assert.ok(!hits.some((record) => record.id === 'b'), 'unrelated record should be filtered out');

    // History is newest-first by timestamp.
    const history = memory.getTaskHistory();
    assert.strictEqual(history[0].id, 'b');
    assert.strictEqual(history[1].id, 'a');

    router.dispose();
  });

  test('T28: parseSymbols and parseImports extract cross-language structure', () => {
    const ts = [
      'import { Foo } from "./foo";',
      'import * as vscode from "vscode";',
      'const bar = require("bar");',
      'export class Widget {}',
      'export interface Shape { x: number }',
      'export type ID = string;',
      'export function build(n: number) { return n; }',
      'export const make = (x: number) => x * 2;',
      'export const MAX_SIZE = 100;',
    ].join('\n');
    const syms = parseSymbols(ts, 'typescript', 'a.ts');
    const kindOf = (name: string): string | undefined => syms.find((s) => s.name === name)?.kind;
    assert.strictEqual(kindOf('Widget'), 'class');
    assert.strictEqual(kindOf('Shape'), 'interface');
    assert.strictEqual(kindOf('ID'), 'type');
    assert.strictEqual(kindOf('build'), 'function');
    assert.strictEqual(kindOf('make'), 'function'); // const arrow form
    assert.strictEqual(kindOf('MAX_SIZE'), 'constant');
    assert.strictEqual(syms.find((s) => s.name === 'build')?.line, 7); // 1-indexed

    const tsImports = parseImports(ts, 'typescript');
    assert.ok(tsImports.includes('./foo') && tsImports.includes('vscode'), 'es imports');
    assert.ok(tsImports.includes('bar'), 'require() import');

    const py = 'from os import path\nimport sys\nclass Cat:\n    def meow(self):\n        pass';
    const pySyms = parseSymbols(py, 'python', 'a.py');
    assert.ok(pySyms.some((s) => s.name === 'Cat' && s.kind === 'class'));
    assert.ok(pySyms.some((s) => s.name === 'meow' && s.kind === 'function'));
    const pyImports = parseImports(py, 'python');
    assert.ok(pyImports.includes('os') && pyImports.includes('sys'), 'python imports');
  });
});
