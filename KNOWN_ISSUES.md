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
- **Same-machine requests skip the token (deliberate).** Loopback-socket
  requests with a loopback Host header get in tokenless, so the site's
  Get Luigi Codes launcher can auto-open the app. The Host check defeats DNS
  rebinding; other login sessions on the same machine could reach the app
  (single-user machines assumed). LAN clients always need the token. CORS is
  answered only for https://luigi-codes.vercel.app, status endpoint only.
- **Stop-marker guard is per-frame.** A chat-template stop marker split across
  two stream frames wouldn't be caught; mlx-lm decodes markers as single
  tokens, so frames carry them whole in practice.

## Capability track (raw-model / training pipeline)

Honest ledger for the reasoning-adapter work (Track A/B). Full iteration log lives in
`docs/REASONING_ROADMAP.md` (local, gitignored); the durable issues + fix plans live here so
they survive across sessions.

- **M1 code-strategy over-trusts executing code (open, fix planned).** `scoreReasoningViaCode`
  in `scripts/eval.mjs` commits to `solve()`'s value whenever the code EXECUTES, even when the
  code is logically wrong, overriding a correct mental answer. Measured cost: on the iter-A40-2
  candidate, +M1 fixed 5 single-fails (counting/combinatorics) but BROKE 2 the model got right
  mentally (reason-e21-telescope 9/10, reason-eh6-sum-3digit 6660) because the generated code ran
  and returned a wrong number. Net still +3, so M1 stays a committed win. FIX PLAN (leak-free,
  do AFTER training so we only patch the residual): add a self-consistency gate: sample `solve()`
  twice; commit to code only when the two independent code answers AGREE, else fall back to
  mental. Land it as a NEW strategy variant and A/B it, do not mutate the committed `code`
  strategy until it beats 35/40 with no regression.

- **Archetype trace-gen: fraction answers must use `type:"text"`, not `"number"` (bug, fix
  known).** In the iter-5 prompt generators, telescoping-sum prompts were labeled `type:"number"`;
  `answerMatches` only does fraction equivalence for `type:"text"` (see `scripts/lib/verify.mjs`,
  the eval's own `reason-e21-telescope` uses `type:"text"`). Result: every correct teacher
  telescoping trace was rejected as wrong-answer. Not blocking now (telescoping is not a
  capability gap: single-mode already passes it), so it was skipped. FIX when a fraction archetype
  is actually needed: set `type:"text"` for fraction-answer prompts.

- **Teacher (DeepSeek-R1-Distill-Qwen-14B) errs on the hardest archetypes (mitigated, not
  eliminated).** On iter-5 generation the 14B teacher produced a wrong final answer on ~24% of the
  hard counting problems (sixth-power miscount in squares-or-cubes, leading-digit slips in
  distinct-digit counts, an arithmetic slip in password inclusion-exclusion). MITIGATION IN PLACE:
  `filter-traces.mjs` correctness-gates every trace against brute-force ground truth, so a wrong
  teacher chain can NEVER enter training (leak-free). Consequence: some archetypes come up thin or
  empty and need a gap-fill pass (more instances + higher temperature so the teacher lands some
  correct samples on varied numbers). Some very long chains (distinct-digit casework) ABORT on the
  generation timeout. FIX PLAN if an archetype stays uncovered after gap-fill: raise gen timeout /
  max-tokens for that archetype, or escalate to a stronger teacher (R1-Distill-32B in 4-bit). RULE:
  if an archetype cannot be covered, report it as still-uncovered, never fake a gain: the HOLDOUT
  suite (never trained on) is the honest generalization check, not the visible 40.

- **`<think>` format normalization (handled).** The R1-14B teacher reasons inline via the chat API
  (no `<think>` tags), while the base reasoner set (`dataset-iter2-concise`) is `<think>`-wrapped.
  The mix-builder wraps archetype reasoning in `<think>...</think>` before the `Final answer:` line
  so the training target is uniform. Not a defect, documented so the format choice is not a
  surprise.

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
