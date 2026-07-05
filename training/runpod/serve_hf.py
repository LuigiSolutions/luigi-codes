#!/usr/bin/env python3
"""
Minimal OpenAI-compatible server for evaluating a trained adapter on the pod
(reasoning roadmap, Phase 2 gate). Dependency-light on purpose: it uses only
transformers + torch (already present for training), so there is no vLLM install
and no risk of a torch version conflict breaking the trained environment.

Point the Luigi eval harness at this over an SSH tunnel so the SAME verifier that
set the baseline also scores the candidate:
  serve base  -> eval  = pod baseline
  serve base + adapter -> eval = pod candidate
Both at fp16 on the exact base the adapter was trained on, so the delta isolates
the adapter's effect (no quantization mismatch).

Usage (on the pod):
  python training/runpod/serve_hf.py --base Qwen/Qwen2.5-Coder-7B-Instruct --port 8000
  python training/runpod/serve_hf.py --base Qwen/Qwen2.5-Coder-7B-Instruct \
    --adapter /workspace/luigi-reasoning-adapter --port 8000
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

STATE = {"tok": None, "model": None, "name": "luigi-candidate"}


def load(base, adapter):
    tok = AutoTokenizer.from_pretrained(base, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        base, dtype=torch.bfloat16, device_map="cuda", trust_remote_code=True
    )
    if adapter:
        from peft import PeftModel
        model = PeftModel.from_pretrained(model, adapter)
        model = model.merge_and_unload()  # fold LoRA in for clean, fast inference
        print(f"Loaded adapter from {adapter} (merged).")
    model.eval()
    STATE["tok"], STATE["model"] = tok, model
    print("Model ready.")


def generate(messages, temperature, max_tokens):
    tok, model = STATE["tok"], STATE["model"]
    # transformers 5.x returns a BatchEncoding here (not a bare tensor); ask for a dict
    # explicitly and splat it into generate so this works across versions.
    enc = tok.apply_chat_template(
        messages, add_generation_prompt=True, return_tensors="pt", return_dict=True
    )
    enc = {k: v.to(model.device) for k, v in enc.items()}
    prompt_len = enc["input_ids"].shape[1]
    do_sample = bool(temperature and temperature > 0)
    # Only pass sampling params when sampling; some transformers builds reject
    # temperature=None / top_p=None under greedy decoding.
    gen_kwargs = dict(
        max_new_tokens=max_tokens,
        do_sample=do_sample,
        pad_token_id=tok.pad_token_id or tok.eos_token_id,
    )
    if do_sample:
        gen_kwargs["temperature"] = temperature
        gen_kwargs["top_p"] = 0.95
    with torch.no_grad():
        out = model.generate(**enc, **gen_kwargs)
    return tok.decode(out[0][prompt_len:], skip_special_tokens=True)


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
            content = generate(
                req.get("messages", []),
                float(req.get("temperature", 0) or 0),
                int(req.get("max_tokens", 1024)),
            )
            self._send(200, {
                "id": "chatcmpl-pod",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": req.get("model", STATE["name"]),
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": content}}],
            })
        except Exception as e:  # never crash the server on one bad request
            import traceback
            traceback.print_exc()
            self._send(500, {"error": repr(e), "trace": traceback.format_exc()[-600:]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="Qwen/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    STATE["name"] = "luigi-candidate" if args.adapter else "luigi-base"
    print(f"Loading {args.base}{' + ' + args.adapter if args.adapter else ' (base only)'} ...")
    load(args.base, args.adapter)
    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    print(f"Serving {STATE['name']} on :{args.port}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
