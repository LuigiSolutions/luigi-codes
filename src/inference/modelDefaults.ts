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
