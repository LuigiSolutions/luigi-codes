# Changelog

All notable changes to Luigi Codes.

## 0.2.0 — 2026-07-03

### Added
- **Web app** — `Luigi: Open Web App (Desktop & Mobile)` serves the full Luigi
  chat as a responsive web page from a zero-dependency local HTTP server.
  Desktop browsers and phones (with `luigi.web.allowLan` on, same Wi-Fi) get
  the complete brand experience: streaming replies, markdown + code blocks
  with copy, stop button, model badge. Every request is protected by a
  per-session access token; nothing leaves your machine or network.
- Standalone launcher: `npm run web -- --endpoint <url> --provider <p> --lan`
  runs the web chat without VS Code at all.
- New settings: `luigi.web.port` (default 8091) and `luigi.web.allowLan`
  (default off).

### Fixed
- Chat-template stop markers (`<|im_end|>`, `<|endoftext|>`, `</s>`) leaked as
  literal text by some OpenAI-compatible local servers (e.g. raw mlx-lm) are
  now stripped and end the reply — in the chat panel, terminal chat, and web
  app alike.

## 0.1.0 — 2026-07-03

Initial release.

- Chat in the activity bar (streaming, markdown, code copy), docked like a
  chat assistant, in the full Luigi Solutions look.
- Agent mode: 5-phase loop — context → plan → human approval modal → execute
  with self-correction → verify — over 11 workspace-guarded tools.
- Model router for Ollama / LM Studio / any OpenAI-compatible local server:
  detection, per-task scoring, streaming, observed-performance feedback.
- Codebase index (symbols, imports, conventions) with semantic retrieval and
  lexical fallback.
- Memory: ChromaDB when available, local JSON always.
- Self-improvement: failure taxonomy → prompt rules; on-device correction
  capture; fine-tune JSONL export (`Luigi: Export Training Data`) with a
  local MLX LoRA recipe (TRAINING.md).
- Editor commands (explain / improve / tests / fix bugs / review), terminal
  chat REPL, agent status dashboard.
