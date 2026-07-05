#!/usr/bin/env python3
"""
Minimal OpenAI-compatible mlx server that RELIABLY applies a runtime LoRA adapter.

Why not scripts/serve-model.py: that wraps mlx_lm.server, whose adapter map is keyed
so the requested model name misses and the adapter is silently dropped (you get the base
model). And fusing the LoRA into the 4-bit base then re-quantizing rounds the small LoRA
deltas away (sub-4-bit-resolution), so the fused model also behaves like the base. The
correct 4-bit deployment is the standard QLoRA path: 4-bit base + fp16 LoRA applied at
runtime. mlx_lm.load(model, adapter_path=...) does exactly that, so this server uses it.

Usage:
  python scripts/serve_mlx_adapter.py \
    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --adapter-path ~/luigi-finetune/luigi-reasoning-adapter-mlx --port 8081
Then point the eval harness at it (any --model string is accepted):
  npm run eval -- --difficulty expert --temperature 0 --endpoint http://localhost:8081 --model luigi-candidate
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

STATE = {"model": None, "tok": None, "name": "luigi-mlx"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/v1/models":
            self._send(200, {"object": "list", "data": [{"id": STATE["name"], "object": "model"}]})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            tok = STATE["tok"]
            prompt = tok.apply_chat_template(
                req.get("messages", []), add_generation_prompt=True, tokenize=False
            )
            temp = float(req.get("temperature", 0) or 0)
            content = generate(
                STATE["model"], tok, prompt=prompt,
                max_tokens=int(req.get("max_tokens", 1024)),
                sampler=make_sampler(temp=temp),
                verbose=False,
            )
            self._send(200, {
                "id": "chatcmpl-mlx", "object": "chat.completion", "created": int(time.time()),
                "model": req.get("model", STATE["name"]),
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": content}}],
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": repr(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter-path", default=None)
    ap.add_argument("--port", type=int, default=8081)
    ap.add_argument("--name", default=None)
    args = ap.parse_args()
    STATE["name"] = args.name or ("luigi-candidate" if args.adapter_path else "luigi-base")
    print(f"Loading {args.model}{' + adapter ' + args.adapter_path if args.adapter_path else ''} ...")
    STATE["model"], STATE["tok"] = load(args.model, adapter_path=args.adapter_path)
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Serving {STATE['name']} on :{args.port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
