#!/usr/bin/env python3
"""
Curb R1 teacher verbosity in a distillation dataset (reasoning roadmap, Phase 2 iter-2).

R1 traces run long. At the product's serving precision the model sometimes reasons past
the eval's token budget before it emits "Final answer:", so a correct chain scores as a
miss. Training on tighter traces teaches the same reasoning in fewer tokens, which reduces
truncation at inference. This step drops any example whose ASSISTANT content (the trace)
exceeds a token cap, measured with the REAL base tokenizer (same one fit-window.py uses),
and writes the survivors to an output dir (leaving the source dataset intact).

Run this BEFORE fit-window.py: curb by trace length, then gate on full templated length.

Usage:
  python scripts/curb-verbosity.py --in-dir training/dataset-iter2 \
    --out-dir training/dataset-iter2-concise --max-assistant-tokens 1800
"""
import argparse
import json
import os
import sys

def assistant_tokens(tok, messages):
    text = "\n".join(m["content"] for m in messages if m.get("role") == "assistant")
    return len(tok.encode(text))

def process(src, dst, tok, cap, dry):
    if not os.path.exists(src):
        return None
    rows = [json.loads(l) for l in open(src, encoding="utf-8") if l.strip()]
    kept, dropped, lengths = [], 0, []
    for r in rows:
        n = assistant_tokens(tok, r["messages"])
        lengths.append(n)
        if n <= cap:
            kept.append(r)
        else:
            dropped += 1
    lengths.sort()
    if not dry:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "w", encoding="utf-8") as f:
            for r in kept:
                f.write(json.dumps(r) + "\n")
    name = os.path.basename(src)
    p = lambda q: lengths[int(q * (len(lengths) - 1))] if lengths else 0
    print(f"  {name}: {len(rows)} -> {len(kept)} kept, {dropped} dropped over {cap} assistant tok "
          f"(pre-cap tokens: p50 {p(.5)}, p90 {p(.9)}, max {lengths[-1] if lengths else 0})")
    return len(kept)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", default="training/dataset-iter2")
    ap.add_argument("--out-dir", default="training/dataset-iter2-concise")
    ap.add_argument("--model", default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")
    ap.add_argument("--max-assistant-tokens", type=int, default=1800,
                    help="drop examples whose assistant trace exceeds this many tokens")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model)
    print(f"curb-verbosity: model={args.model} cap={args.max_assistant_tokens} assistant-tok"
          f"{' (dry-run)' if args.dry_run else ''}")

    total = 0
    for name in ("train.jsonl", "valid.jsonl"):
        n = process(os.path.join(args.in_dir, name),
                    os.path.join(args.out_dir, name), tok, args.max_assistant_tokens, args.dry_run)
        if name == "train.jsonl":
            total = n if n is not None else 0
    if total < 500:
        print(f"\nWARNING: train.jsonl has {total} examples (< 500). Loosen the cap or import more.")
        sys.exit(3)
    print(f"\nOK: train.jsonl has {total} examples within the {args.max_assistant_tokens}-token trace cap.")

if __name__ == "__main__":
    main()
