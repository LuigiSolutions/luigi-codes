# Known Issues & Accepted Deviations

Honest ledger of what is knowingly imperfect, so nobody rediscovers these as surprises.

## Partially wired

- **Correction capture** — now wired for the clean case: when the agent's `writeFile`
  produces a complete file, `SelfImprovement.noteProducedFile()` records a baseline,
  and `onDidSaveTextDocument` → `reconcileSavedFile()` captures a human's later edit
  (within a 1-hour TTL, learned once) as an on-device training pair. **Not yet
  covered:** `editFile` writes (partial edits — the post-edit whole-file content isn't
  reconstructed for a baseline) and code the user copies out of a chat reply. Those
  remain future work; the highest-signal path (full agent-authored files) is live.

## Accepted design deviations (deliberate, do not "fix")

- **Gold gradient in `media/*.svg`** — the icon/wordmark use a three-stop gradient
  (`#dcc18d → #c9a86a → #a8874d`). luigi-os knows one flat gold; the gradient is a
  deliberate premium treatment built strictly from the derived gold steps documented
  in `designTokens.ts`.
- **🍄 persona glyph** — used consistently (panel title, assistant label, status bar,
  terminal banner, log prefix). The seal in `media/` is the formal mark; the mushroom
  is the product persona.
- **Derived tokens** — surfaces `#1d1a14`/`#242019`, gold light/dark, radii 4/8px are
  extensions of the luigi-os anchors, labeled "derived" in `designTokens.ts`. If
  luigi-os later defines canonical values, replace them.

## Single-root workspace assumption

- The codebase index keys entries by workspace-relative path **without** the
  folder name, and `resolveSafe()` resolves tool paths against
  `workspaceFolders[0]`. In a **multi-root** workspace two roots sharing a path
  (e.g. each with `src/index.ts`) collide in the index, and a tool path may
  resolve against the wrong root. Luigi assumes a single-root workspace today;
  multi-root support (folder-qualified keys + per-root resolution) is future
  work. Single-root — the overwhelmingly common case — is unaffected.

## Web app scope (deliberate)

- **Chat-only, no agent mode.** The agent's tools mutate the workspace and its
  human-approval modal lives in VS Code; exposing that over LAN to a phone would
  bypass the approval boundary. The web app is a conversation surface.
- **Plain HTTP on the LAN.** Traffic between phone and Mac is unencrypted on
  your Wi-Fi (like most local-network tools). The per-session token gates
  access; treat the URL like a password. HTTPS would require a self-signed
  cert ceremony on every device — declined for now.
- **Stop-marker guard is per-frame.** A chat-template stop marker split across
  two stream frames wouldn't be caught; mlx-lm decodes markers as single
  tokens, so frames carry them whole in practice.

## Environmental / trade-offs

- **Mixed embedding spaces score 0** — task memories embedded with a model vector are
  invisible to hash-fallback queries (and vice versa) by design: cosine across spaces
  is noise. Consequence: stopping Ollama hides model-embedded memories from
  `findSimilar()` until it returns (history list is unaffected).
- **`resolveSafe()` does not resolve symlinks** — a pre-existing symlink inside the
  workspace pointing outside it can be followed by file tools. Mutating tools sit
  behind the approval modal, and `executeShell` (equally powerful) is approval-gated
  too, so the modal remains the real boundary.
- **mocha transitive dev-deps pinned by `overrides`** — `serialize-javascript@^7.0.5`
  and `diff@^8.0.3` are forced to clear `npm audit`; remove the overrides when mocha
  ships them upstream. Dev-only, never in the extension runtime.
