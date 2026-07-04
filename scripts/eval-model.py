#!/usr/bin/env python3
"""Luigi Codes — local model evaluation harness.

Scores a base model (optionally with a LoRA adapter) against
eval/benchmark.jsonl. Each case lists expected keywords (each present = credit)
and forbidden strings (any present = case fails). Deterministic, offline, no
LLM judge — honest keyword scoring you can compare across training runs.

Usage (with the mlx venv):
  ~/.luigi-mlx/bin/python scripts/eval-model.py                      # base model
  ~/.luigi-mlx/bin/python scripts/eval-model.py --adapter-path DIR   # tuned
  ~/.luigi-mlx/bin/python scripts/eval-model.py --label "iter100" --adapter-path DIR

Requires mlx-lm (dev tooling; NOT part of npm test — needs a model on disk).
"""
import argparse
import json
import os
import sys

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="mlx-community/Qwen2.5-Coder-7B-Instruct-4bit")
    parser.add_argument("--adapter-path", default=None)
    parser.add_argument("--benchmark", default=os.path.join(os.path.dirname(__file__), "..", "eval", "benchmark.jsonl"))
    parser.add_argument("--max-tokens", type=int, default=200)
    parser.add_argument("--label", default=None, help="name for this run in the report")
    args = parser.parse_args()

    from mlx_lm import load, generate  # deferred: give argparse errors fast

    label = args.label or ("adapter" if args.adapter_path else "base")
    model, tokenizer = load(args.model, adapter_path=args.adapter_path)

    cases = [json.loads(line) for line in open(args.benchmark) if line.strip()]
    total_hits = 0
    total_expected = 0
    failed_cases = []
    per_category: dict[str, list[float]] = {}

    for case in cases:
        prompt = tokenizer.apply_chat_template(
            [{"role": "user", "content": case["question"]}],
            add_generation_prompt=True,
            tokenize=False,
        )
        reply = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens)
        low = reply.lower()
        hits = sum(1 for kw in case["expect"] if kw.lower() in low)
        forbidden = [f for f in case.get("forbid", []) if f.lower() in low]
        score = 0.0 if forbidden else hits / max(len(case["expect"]), 1)
        total_hits += 0 if forbidden else hits
        total_expected += len(case["expect"])
        per_category.setdefault(case["category"], []).append(score)
        marker = "PASS" if score == 1.0 else ("FORBID" if forbidden else "part")
        if score < 1.0:
            failed_cases.append((case["id"], marker, hits, len(case["expect"]), forbidden))
        print(f"  [{marker:6}] {case['id']:16} {hits}/{len(case['expect'])}"
              + (f"  forbidden: {forbidden}" if forbidden else ""))

    overall = total_hits / max(total_expected, 1)
    print(f"\n== {label} :: overall {overall * 100:.1f}% ({total_hits}/{total_expected} expected keywords) ==")
    for category, scores in sorted(per_category.items()):
        print(f"   {category:13} {sum(scores) / len(scores) * 100:.0f}%  ({len(scores)} case(s))")
    return 0

if __name__ == "__main__":
    sys.exit(main())
