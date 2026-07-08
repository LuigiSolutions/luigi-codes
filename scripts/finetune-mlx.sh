#!/usr/bin/env bash
# Luigi Codes — one-command local LoRA fine-tune on Apple Silicon (MLX).
#
# Usage: scripts/finetune-mlx.sh <data-dir> [base-model] [adapter-out]
#   <data-dir>    folder containing train.jsonl + valid.jsonl
#                 (produced by "Luigi: Export Training Data")
#   [base-model]  HF/MLX model id (default: 4-bit Qwen2.5-Coder-7B, fits 16 GB)
#   [adapter-out] where to write the LoRA adapter (default: ./luigi-adapter)
#
# On-machine, no cloud, no data leaves this computer. See TRAINING.md.
set -euo pipefail

DATA_DIR="${1:-}"
BASE_MODEL="${2:-mlx-community/Qwen2.5-Coder-7B-Instruct-4bit}"
ADAPTER_OUT="${3:-./luigi-adapter}"

if [[ -z "$DATA_DIR" ]]; then
  echo "usage: scripts/finetune-mlx.sh <data-dir> [base-model] [adapter-out]" >&2
  exit 2
fi
if [[ ! -f "$DATA_DIR/train.jsonl" || ! -f "$DATA_DIR/valid.jsonl" ]]; then
  echo "error: $DATA_DIR must contain train.jsonl and valid.jsonl" >&2
  echo "       run 'Luigi: Export Training Data' first." >&2
  exit 1
fi
if ! command -v mlx_lm.lora >/dev/null 2>&1; then
  echo "error: mlx-lm not installed. run: pip install mlx-lm" >&2
  exit 1
fi

echo "🍄 Luigi: fine-tuning $BASE_MODEL on $DATA_DIR"
echo "   train: $(wc -l < "$DATA_DIR/train.jsonl") examples · valid: $(wc -l < "$DATA_DIR/valid.jsonl")"

# --grad-checkpoint keeps peak GPU memory ~7.6 GB so a 7B LoRA fits the 16 GB M4;
# without it, num-layers 8+ OOMs on longer sequences (Metal Insufficient Memory).
# --mask-prompt trains on the completion only (standard instruction-tuning objective).
# Both validated on-machine (M4/16GB) 2026-07-08.
mlx_lm.lora \
  --model "$BASE_MODEL" \
  --train \
  --data "$DATA_DIR" \
  --iters 600 \
  --batch-size 1 \
  --num-layers 8 \
  --grad-checkpoint \
  --mask-prompt \
  --adapter-path "$ADAPTER_OUT"

echo "🍄 Done. Adapter written to $ADAPTER_OUT"
echo "   test:  mlx_lm.generate --model $BASE_MODEL --adapter-path $ADAPTER_OUT --prompt \"...\""
echo "   fuse:  mlx_lm.fuse --model $BASE_MODEL --adapter-path $ADAPTER_OUT --save-path ./luigi-coder"
