#!/usr/bin/env python3
"""
Minimal OpenAI-compatible server for a HF causal LM on CUDA (RunPod fallback when vLLM's newest
wheels want a CUDA newer than the pod driver). Uses plain transformers + torch, so it runs on the
torch build that matches the pod driver (cu124 here), and applies a PEFT LoRA adapter at runtime
(--adapter-path) the same way the mlx server does locally.

Speaks what ModelRouter and scripts/eval.mjs expect: GET /v1/models, POST /v1/chat/completions
with stream:true (SSE) or a single JSON body. Greedy at temperature 0 for reproducible evals.

Usage on the pod:
  python scripts/serve_hf_cuda.py --model Qwen/Qwen2.5-Coder-7B-Instruct --port 8000 --name luigi-base
  python scripts/serve_hf_cuda.py --model Qwen/... --adapter-path /workspace/adapter --name luigi-candidate
"""
import argparse
import json
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TextIteratorStreamer

STATE = {"model": None, "tok": None, "name": "luigi-hf"}


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

    def _build_inputs(self, messages):
        tok = STATE["tok"]
        text = tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        return tok(text, return_tensors="pt").to(STATE["model"].device)

    def _gen_kwargs(self, req, inputs):
        temp = float(req.get("temperature", 0) or 0)
        max_new = int(req.get("max_tokens", 1024))
        kw = dict(max_new_tokens=max_new, pad_token_id=STATE["tok"].eos_token_id)
        if temp and temp > 0:
            kw.update(do_sample=True, temperature=temp)
        else:
            kw.update(do_sample=False)
        return kw

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/chat/completions":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            inputs = self._build_inputs(req.get("messages", []))
            gen_kwargs = self._gen_kwargs(req, inputs)
            model_name = req.get("model", STATE["name"])

            if req.get("stream"):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.end_headers()
                created = int(time.time())
                streamer = TextIteratorStreamer(STATE["tok"], skip_prompt=True, skip_special_tokens=True)
                thread = threading.Thread(
                    target=STATE["model"].generate, kwargs={**inputs, **gen_kwargs, "streamer": streamer}
                )
                thread.start()
                for piece in streamer:
                    chunk = {
                        "id": "chatcmpl-hf", "object": "chat.completion.chunk", "created": created,
                        "model": model_name,
                        "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                thread.join()
                done = {
                    "id": "chatcmpl-hf", "object": "chat.completion.chunk", "created": created,
                    "model": model_name,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                self.wfile.write(f"data: {json.dumps(done)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                return

            with torch.no_grad():
                out = STATE["model"].generate(**inputs, **gen_kwargs)
            text = STATE["tok"].decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)
            self._send(200, {
                "id": "chatcmpl-hf", "object": "chat.completion", "created": int(time.time()),
                "model": model_name,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": text}}],
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            self._send(500, {"error": repr(e)})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--adapter-path", default=None)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--name", default=None)
    args = ap.parse_args()
    STATE["name"] = args.name or ("luigi-candidate" if args.adapter_path else "luigi-base")
    print(f"Loading {args.model}{' + adapter ' + args.adapter_path if args.adapter_path else ''} ...", flush=True)
    tok = AutoTokenizer.from_pretrained(args.model)
    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16, device_map="cuda")
    if args.adapter_path:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, args.adapter_path)
    model.eval()
    STATE["model"], STATE["tok"] = model, tok
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Serving {STATE['name']} on :{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
