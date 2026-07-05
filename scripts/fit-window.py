#!/usr/bin/env python3
"""
Fit the distillation dataset to the training context window (reasoning roadmap, Phase 2).

filter-traces.mjs bounds trace length in CHARACTERS, but LaTeX-dense math tokenizes far
denser than plain text (as low as ~1.4 chars/token), so a char cap does not bound tokens.
If an example exceeds the trainer's max_seq_len it is truncated from the end, cutting off
the "Final answer:" line and teaching the model to reason but never conclude. This step
uses the REAL base tokenizer to drop any example whose chat-templated length exceeds the
budget, so every surviving example trains complete under train_sft.py's --max-seq-len.

Usage:
  python scripts/fit-window.py                                  # defaults: 4096-token window
  python scripts/fit-window.py --max-tokens 4096 --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit
  python scripts/fit-window.py --in-dir training/dataset --dry-run
"""
import argparse
import json
import os
import sys

def templated_len(tok, messages):
    # Build the exact string the trainer sees, then count tokens. (tokenize=True misbehaves
    # on some mlx tokenizer repos, so render to text first, then encode.)
    try:
        text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    except Exception:
        text = "\n".join(m["content"] for m in messages)
    return len(tok.encode(text))

def process(path, tok, budget, dry):
    if not os.path.exists(path):
        return None
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    kept, dropped = [], 0
    lengths = []
    for r in rows:
        n = templated_len(tok, r["messages"])
        lengths.append(n)
        if n <= budget:
            kept.append(r)
        else:
            dropped += 1
    lengths.sort()
    if not dry:
        with open(path, "w", encoding="utf-8") as f:
            for r in kept:
                f.write(json.dumps(r) + "\n")
    name = os.path.basename(path)
    p = lambda q: lengths[int(q * (len(lengths) - 1))] if lengths else 0
    print(f"  {name}: {len(rows)} -> {len(kept)} kept, {dropped} dropped over {budget} tok "
          f"(pre-gate tokens: p50 {p(.5)}, p90 {p(.9)}, max {lengths[-1] if lengths else 0})")
    return len(kept)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in-dir", default="training/dataset")
    ap.add_argument("--model", default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")
    ap.add_argument("--max-tokens", type=int, default=4096,
                    help="trainer context window; examples whose templated length exceeds this are dropped")
    ap.add_argument("--margin", type=int, default=64, help="safety margin below the window")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(args.model)
    budget = args.max_tokens - args.margin
    print(f"fit-window: model={args.model} window={args.max_tokens} budget={budget}"
          f"{' (dry-run)' if args.dry_run else ''}")

    total = 0
    for name in ("train.jsonl", "valid.jsonl"):
        n = process(os.path.join(args.in_dir, name), tok, budget, args.dry_run)
        if name == "train.jsonl":
            total = n if n is not None else 0
    if total < 500:
        print(f"\nWARNING: train.jsonl has {total} examples (< 500). Import more before training.")
        sys.exit(3)
    print(f"\nOK: train.jsonl has {total} examples within the {args.max_tokens}-token window.")

if __name__ == "__main__":
    main()
