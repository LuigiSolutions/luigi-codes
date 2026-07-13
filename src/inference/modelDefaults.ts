/**
 * Luigi Codes — model configuration defaults (vscode-free).
 *
 * Single source of truth for the default provider/endpoint/model. Lives in its
 * own module with NO vscode import so it can be shared by both the extension
 * (modelRouter.ts, extension.ts) and the plain-Node standalone web app
 * (web/standalone.ts, inference/modelServer.ts) without dragging the 'vscode'
 * module into a context where it does not exist. See web/webServer.ts for the
 * same vscode-free contract.
 */

/** Base model Luigi Codes' own LoRA fine-tune is served on top of via scripts/serve-model.py. */
export const LUIGI_TRAINED_MODEL_ID = 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit';

/** Default inference provider: Luigi's own fine-tuned model server (OpenAI wire format). */
export const DEFAULT_PROVIDER = 'custom';

/** Default inference endpoint: where scripts/serve-model.py listens. */
export const DEFAULT_MODEL_ENDPOINT = 'http://localhost:8080';

/**
 * Cross-platform model Luigi provisions via Ollama when a machine has no local
 * model yet (Apple Silicon users get Luigi's own mlx model; everyone else gets
 * this through Ollama, which runs on Mac/Windows/Linux). Flip this to the
 * published Luigi model id (e.g. 'luigisolutions/luigi-coder') once the
 * fine-tuned model ships to the Ollama registry — see TRAINING.md.
 */
export const RECOMMENDED_OLLAMA_MODEL = 'qwen2.5-coder:7b';

/** Embedding model pulled alongside the chat model for the index + memory. */
export const RECOMMENDED_EMBED_MODEL = 'nomic-embed-text';

/** OpenAI wire = /v1/*; Ollama wire = /api/*. */
export type ModelWire = 'ollama' | 'openai';

export interface KnownBackend {
  endpoint: string;
  provider: string;
  wire: ModelWire;
}

/**
 * Local inference servers people actually run, probed in this order (Luigi's
 * own model server first, since it is the default). Shared by the extension's
 * ModelRouter and the standalone web server so the two surfaces resolve the
 * same backend and never disagree about where a model lives.
 */
export const KNOWN_LOCAL_BACKENDS: KnownBackend[] = [
  { endpoint: DEFAULT_MODEL_ENDPOINT, provider: 'custom', wire: 'openai' }, // Luigi's own (mlx / llama.cpp)
  { endpoint: 'http://localhost:11434', provider: 'ollama', wire: 'ollama' }, // Ollama
  { endpoint: 'http://localhost:1234', provider: 'lmstudio', wire: 'openai' }, // LM Studio
];
