# 🍄 Luigi Codes

**Premium local AI coding agent by [Luigi Solutions](https://github.com/LuigiSolutions). Private, powerful, yours.**

**Site:** [luigi-codes.vercel.app](https://luigi-codes.vercel.app) · **Source:** [github.com/LuigiSolutions/luigi-codes](https://github.com/LuigiSolutions/luigi-codes)

Luigi Codes is a VS Code extension that puts a full coding agent — chat, editor commands, an autonomous tool-running agent loop, codebase intelligence, long-term memory, and a self-improvement system — on top of **models that run entirely on your machine**. No API keys, no per-token bills, no code leaving your computer.

---

## Why

- **Ownership.** Your assistant, your models, your data, your brand. No vendor can change the price, the model, or the terms underneath you.
- **Privacy.** Prompts, code, memory, and improvement data never leave localhost.
- **Compounding.** Every run is recorded, analyzed, and folded back into better planning prompts — and accumulates into a fine-tuning dataset that is yours.

## Features

| | |
|---|---|
| 💬 **Chat panel** | Streaming conversation in the full Luigi Solutions look — warm near-black canvas, gold hairline frames, editorial serif welcome |
| 🤖 **Agent mode** | 5-phase loop: gather context → plan → **human approval modal** → execute tools with self-correction → verify honestly |
| 🛠 **16 tools** | readFile, writeFile, editFile, deleteFile, executeShell, grep, gitDiff, gitLog, runTests, lspDiagnostics, lspReferences — all path-guarded to the workspace — plus 5 GitHub tools |
| 🐙 **GitHub connector** | `Luigi: Connect GitHub` (VS Code's built-in GitHub sign-in) lets the agent list, read, and review your repos, commit to branches, and open pull requests — writes always behind the approval gate. The web app connects with a fine-grained token |
| 🧭 **Model router** | Detects installed Ollama / LM Studio models, scores them per task (capability × quality × speed × observed performance), routes every call |
| 🗺 **Codebase index** | Symbols, imports, conventions, and framework detection across the workspace; semantic retrieval via local embeddings with a lexical fallback |
| 🧠 **Memory** | Every agent run stored in ChromaDB (when running) plus a local JSON mirror; similar past tasks inform new plans |
| 📈 **Self-improvement** | Failure taxonomy → standing prompt rules; on-device correction capture (human edits of Luigi-written files become training pairs); fine-tune readiness reported when the dataset is worth training on |
| ⌨️ **Terminal chat** | A gold-on-black REPL (`Luigi: Open Terminal Chat`) for quick questions without leaving the terminal |
| 🌐 **Web app** | `Luigi: Open Web App` serves the chat as a responsive web page — use it in any desktop browser, or from your phone on the same Wi-Fi (`luigi.web.allowLan`). Token-locked, zero dependencies, nothing leaves your network |

## Requirements

1. **VS Code** 1.85+
2. **A local inference server.** By default Luigi runs its own fine-tuned model
   (provider `custom`, `http://localhost:8080`), auto-started on launch once the
   local model is set up (see [TRAINING.md](TRAINING.md)). If you'd rather bring
   your own model, point Luigi at [Ollama](https://ollama.com) or LM Studio by
   changing `luigi.model.provider` / `luigi.model.endpoint` in settings.
3. Bringing your own model via Ollama? Pull at least one:

```bash
# recommended starting set for the Ollama path
ollama pull qwen2.5-coder:7b       # strong small coder
ollama pull nomic-embed-text       # embeddings for index + memory
```

> **Honest sizing note:** small local models (7–13B) are genuinely useful but are not frontier-model equivalents. Quality scales with what your hardware can serve — `qwen2.5-coder:32b` or larger on a capable machine narrows the gap substantially. The router is built so you can swap upward without touching anything else. Optional: run `chroma run` (ChromaDB) on port 8000 for vector memory; Luigi falls back to local JSON automatically.

## Install & Run (development)

```bash
cd luigi-codes
npm install
npm run compile
code .
# press F5 → "Run Luigi Codes" launches an Extension Development Host
```

## The web app (desktop & mobile)

Run **`Luigi: Open Web App (Desktop & Mobile)`** from the command palette — Luigi
starts a zero-dependency local HTTP server and gives you a URL that opens the full
chat in any browser. To use it from your phone: enable **`luigi.web.allowLan`**,
re-run the command, and open the phone URL it offers (same Wi-Fi). Every URL
carries a per-session access token — without it the server shows a locked page.

No VS Code around? The web chat also runs standalone:

```bash
npm run web -- --endpoint http://localhost:11434 --provider ollama --lan
```

The browser talks only to this server; this server talks only to your local
inference endpoint. Nothing leaves your machine (or, with `--lan`, your network).

## Testing & audits

All of these pass with **no model server running** — that is the contract.

```bash
npm test                 # integration suite (T1–T25) in a real downloaded VS Code:
                         # activation, commands, webview CSP/nonce, tool registry,
                         # router fallback, plan parsing, brand-token emission
npm run audit:imports    # every import resolves; zero circular dependencies
npm run audit:brand      # every hex/rgba in src/, media/, package.json is on-palette
npm run audit:copy       # zero em dashes in user-facing copy (src/, api/, site/, media/)
```

The first `npm test` downloads a VS Code build into `.vscode-test/` (~260 MB, cached).

Open the Luigi icon in the activity bar, or run **`Luigi: Open Chat`** from the command palette.

## Commands

| Command | What it does |
|---|---|
| `Luigi: Open Chat` | The main chat panel (Chat + Agent modes) |
| `Luigi: Explain Selected Code` | Editor selection → explanation |
| `Luigi: Improve Selected Code` | Editor selection → improved version + change list |
| `Luigi: Generate Tests` | Editor selection → unit tests |
| `Luigi: Find & Fix Bugs` | Editor selection → bug list + corrected code |
| `Luigi: Review Code` | Whole active file review |
| `Luigi: Open Terminal Chat` | REPL chat in a terminal |
| `Luigi: Open Web App (Desktop & Mobile)` | Start/manage the local web chat server; open in browser or copy the phone URL |
| `Luigi: Connect GitHub` | Sign in with GitHub so Luigi can review repos and push approved updates |
| `Luigi: Show Agent Status` | Models, index, memory, improvement, tools |
| `Luigi: Export Training Data` | Dump collected data as fine-tune JSONL (train/valid) — see [TRAINING.md](TRAINING.md) |
| `Luigi: Set Up Local Model` | One-click: get a working local model running (via Ollama on Mac/Windows/Linux) |

## Configuration

| Setting | Default | Purpose |
|---|---|---|
| `luigi.model.provider` | `custom` | `custom` (Luigi's own model, auto-started), `ollama`, or `lmstudio` |
| `luigi.model.endpoint` | `http://localhost:8080` | Inference server URL (Luigi's model server by default) |
| `luigi.model.primaryModel` | `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` | Base model Luigi's LoRA is served on |
| `luigi.model.fallbackModel` | `qwen2.5-coder:7b` | Used when primary is missing (e.g. via Ollama) |
| `luigi.model.embeddingModel` | `nomic-embed-text` | Embeddings for index + memory |
| `luigi.agent.autoApprove` | `false` | Skip the modal for read-only plans only; mutating plans always ask |
| `luigi.agent.maxRetries` | `3` | Self-correction attempts per failed step |
| `luigi.memory.chromaEndpoint` | `http://localhost:8000` | ChromaDB server |
| `luigi.web.port` | `8091` | Port for the web app |
| `luigi.web.allowLan` | `false` | Let phones on your Wi-Fi open the web app (token still required) |
| `luigi.ui.theme` | `premium-black` | `premium-black` or `premium-dark` |

## Architecture

```
src/
├── extension.ts              activation, 11 commands, status bar, terminal chat
├── ui/designTokens.ts        Luigi Solutions brand tokens (single source of truth)
├── chat/chatPanel.ts         chat webview + activity-bar sidebar
├── chat/markdown.ts          the one markdown renderer (panel, web app, tests)
├── inference/modelRouter.ts  model registry · detection · routing · streaming
├── inference/streamText.ts   NDJSON/SSE stream parsing + stop-marker guard (vscode-free)
├── github/githubClient.ts    zero-dep GitHub REST client (vscode-free, both surfaces)
├── github/githubTools.ts     the agent's GitHub tools (writes behind approval)
├── web/webServer.ts          zero-dep HTTP server: responsive chat for desktop & mobile
├── web/standalone.ts         `npm run web` — the web chat without VS Code
├── agent/
│   ├── agentLoop.ts          the 5-phase agent (context→plan→approve→execute→verify)
│   └── tools/toolRegistry.ts the agent's 11 workspace-guarded tools
├── context/codebaseIndex.ts  symbols, imports, patterns, semantic retrieval
├── memory/memorySystem.ts    ChromaDB + local JSON task memory
├── improvement/selfImprove.ts failure taxonomy → prompt rules → fine-tune readiness
└── test/                     @vscode/test-electron + mocha integration suite (T1–T25)
scripts/
├── audit-imports.mjs         import resolution + circular-dependency audit
├── audit-brand.mjs           palette compliance audit (src/, media/, package.json)
└── audit-copy.mjs            em-dash-free user copy audit (src/, api/, site/, media/)
```

Data flow, one run: `chatPanel` → `agentLoop.execute()` → `codebaseIndex` + `memorySystem` (context) → `modelRouter` (plan) → approval modal → `toolRegistry` (execute, self-correct) → `modelRouter` (verify) → `memorySystem.storeTask()` + `selfImprove.analyzeTask()`.

## Brand

Every color in this extension is the Luigi Solutions palette, taken exactly from `luigi-os/packages/ui/src/theme.css`: canvas `#0b0a09`, surface `#16140f`, ink `#f3efe7`, **gold `#c9a86a`**, danger `#e8796e`, success `#a3c585`, warning `#d9924a`, info `#8fb5c9` — with the signature gold-at-32% hairline, eyebrow tracking `0.15em`, wordmark tracking `0.3em`, and the house easing `cubic-bezier(0.16, 1, 0.3, 1)`. Derived steps (elevated surfaces, gold light/dark) live only in `src/ui/designTokens.ts`.

## Roadmap

- Inline completions (ghost text) provider
- Diff-preview apply for agent file edits
- ✅ Fine-tune export (`JSONL`) + one-command local LoRA recipe (`Luigi: Export Training Data` + [TRAINING.md](TRAINING.md))
- Multi-model ensemble verification for high-stakes edits
- Serve Luigi's own fine-tuned model as the engine for **LuigiOS** (see below)

## Related projects

Luigi Codes is part of the wider Luigi Solutions product family:

- **[LuigiOS](https://github.com/LuigiSolutions/luigi-os)**: the umbrella product (desktop, mobile, web). Luigi Codes is planned to become its engine, so LuigiOS apps will point at the same on-machine fine-tuned model that Luigi Codes trains and serves, rather than training a separate one.
- **[luigi-os-mible-app](https://github.com/LuigiSolutions/luigi-os-mible-app)**: the LuigiOS mobile client.

The model lives here (training + serving); LuigiOS consumes it as a client. See [TRAINING.md](TRAINING.md) for how the model is served.

---

© Luigi Solutions. Built to be owned.
