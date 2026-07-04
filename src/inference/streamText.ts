/**
 * Luigi Codes — streaming wire-format helpers.
 *
 * Shared by the model router (extension host) and the web server (plain Node,
 * no `vscode` module) — so this file must never import vscode. Single source
 * for parsing the two local-inference stream dialects: Ollama NDJSON and the
 * OpenAI SSE wire format used by LM Studio / custom servers.
 */

export interface SseChunk {
  choices?: { delta?: { content?: string } }[];
  error?: { message?: string } | string;
}

/**
 * Parse one SSE data payload. Returns undefined for a malformed frame (e.g. a
 * proxy heartbeat) so the caller can skip it without aborting the stream; a
 * well-formed frame carrying an `error` is returned so the caller can raise it.
 */
export function parseSseChunk(payload: string): SseChunk | undefined {
  try {
    return JSON.parse(payload) as SseChunk;
  } catch {
    return undefined;
  }
}

/**
 * Chat-template stop markers some OpenAI-compatible local servers (e.g. raw
 * mlx-lm) leak into the stream as literal text instead of stopping on them.
 * Ollama strips these itself; this guard is for the OpenAI wire path.
 */
const STOP_MARKERS = ['<|im_end|>', '<|endoftext|>', '</s>'];

/**
 * Cut a streamed token at the first leaked stop marker. `stop: true` means
 * the marker was seen and the caller should treat the stream as finished.
 * (A marker split across two frames is not caught — mlx decodes each marker
 * as a single token, so in practice frames carry it whole.)
 */
export function splitAtStopMarker(token: string): { text: string; stop: boolean } {
  let cut = -1;
  for (const marker of STOP_MARKERS) {
    const at = token.indexOf(marker);
    if (at >= 0 && (cut === -1 || at < cut)) {
      cut = at;
    }
  }
  return cut === -1 ? { text: token, stop: false } : { text: token.slice(0, cut), stop: true };
}

/** Split a streaming body into trimmed non-empty lines (NDJSON / SSE). */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          yield line;
        }
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode(); // flush any trailing partial multibyte char
    const tail = buffer.trim();
    if (tail.length > 0) {
      yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}
