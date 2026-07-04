# CLAUDE.md — Luigi Codes

Self-anchor for every AI session working in this repo. Read this before touching anything.

## CONTEXT

This is **Luigi Codes** — Luigi Solutions' private local AI coding agent, a VS Code
extension: chat panel, 5-phase agent loop (context → plan → **human approval modal** →
execute with self-correction → verify) with an 11-tool registry, a model router for
Ollama / LM Studio, a codebase index, ChromaDB + JSON memory, and a self-improvement
subsystem. Ten strict-TypeScript source files under `src/`, plus an integration test
suite (`src/test/`, @vscode/test-electron + mocha) and audit scripts (`scripts/`).
Read `README.md` and `src/extension.ts` before changing anything.

**Product vision:** an expert local coding/software/AI assistant that is as independent
as possible (connectors optional, never required) — amazing quality at the cheapest
cost. Everything runs on-machine; no cloud dependency, ever.

## HARD CONVENTIONS (violating any of these = a failure)

- Every color flows through `src/ui/designTokens.ts` → CSS vars. **NEVER hardcode hex.**
  Brand gold is **#c9a86a** (NOT #D4A853). Source of truth:
  `/Users/luigisolutions/code/luigi-os/packages/ui/src/theme.css`
  (canvas `#0b0a09`, surface `#16140f`, ink `#f3efe7`, danger `#e8796e`,
  success `#a3c585`, warning `#d9924a`, info `#8fb5c9`; gold-at-32% hairlines;
  eyebrow tracking `0.15em`; easing `cubic-bezier(0.16,1,0.3,1)`).
- **Zero RUNTIME npm dependencies.** devDependencies for testing are allowed.
- New capabilities = registered tools in `toolRegistry.ts` with `resolveSafe()`
  path guarding. TypeScript strict, no `any` without written reason.
- Machine: Apple M4 / 16GB. Ollama may not be installed — everything you build/test
  must pass **WITHOUT a model server running**.

## Verification loop (run all of these before calling anything done)

```bash
npm run compile          # zero errors, zero warnings
npm test                 # integration suite T1–T10 in a real extension host
npm run audit:imports    # every import resolves, zero circular deps
npm run audit:brand      # every hex/rgba in src/, media/, package.json on-palette
```

Note for agent sessions: `npm test` spawns a downloaded VS Code; the launcher
(`src/test/runTest.ts`) strips inherited `ELECTRON_RUN_AS_NODE`/`VSCODE_*` env vars —
do not remove that or tests break inside VS Code terminals.

## Design-system usage rules (learned, enforced by review)

- Two border tiers ONLY: gold-at-32% hairline (decorative) and full gold (sole signal
  of a control/focus). No middle tier.
- Gold is an accent, never wallpaper: eyebrows, key figures, focus, interactive
  borders. Bold prose and inline code stay ink.
- Wordmark tracking (0.3em) is only for the wordmark, in serif; labels use eyebrow
  tracking (0.15em); `ink-faint` is decorative meta only, never functional text.
- Accepted deviations (documented in KNOWN_ISSUES.md): gold gradient in media SVGs
  built from the derived gold steps; 🍄 as the persona glyph; derived radii/surfaces
  in designTokens.ts marked "derived".
