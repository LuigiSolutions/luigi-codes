#!/usr/bin/env bash
# Bring up an OpenAI-compatible server for the base model on a CUDA pod (RunPod A6000),
# so the local eval harness can measure it over the network without cooking the Mac.
#
# Why vLLM (not the mlx server): scripts/serve_mlx_adapter.py is Apple-Silicon only. vLLM is
# the standard CUDA path, exposes /v1/chat/completions + /v1/models with stream support (what
# ModelRouter and eval.mjs speak), and can apply a LoRA adapter at runtime later
# (--enable-lora --lora-modules luigi-candidate=/path/to/adapter) for candidate evals.
#
# Precision note: we serve full bf16 here (the A6000's 48GB fits the 7B comfortably). This is a
# DIFFERENT precision than the local mlx-8bit product baseline, so pod evals are compared against
# a POD baseline measured the same way (re-baseline once), never against the local mlx-8bit bars.
#
# Usage on the pod:
#   bash scripts/serve-vllm-pod.sh                       # base model, port 8000, name luigi-base
#   ADAPTER=/root/luigi-adapter NAME=luigi-candidate bash scripts/serve-vllm-pod.sh
set -euo pipefail

MODEL="${MODEL:-Qwen/Qwen2.5-Coder-7B-Instruct}"
PORT="${PORT:-8000}"
NAME="${NAME:-luigi-base}"
MAXLEN="${MAXLEN:-8192}"
ADAPTER="${ADAPTER:-}"

echo "== ensuring vLLM is installed =="
# RunPod's base image is PEP-668 externally-managed and this pod is disposable, so install into
# the system env with --break-system-packages (a training run later uses its own venv).
python -c "import vllm" 2>/dev/null || pip install --break-system-packages "vllm>=0.6.0"

ARGS=(
  --model "$MODEL"
  --served-model-name "$NAME"
  --host 0.0.0.0 --port "$PORT"
  --dtype bfloat16
  --max-model-len "$MAXLEN"
  --gpu-memory-utilization 0.90
)

# Runtime LoRA (candidate evals). vLLM applies the fp16 adapter over the bf16 base, the
# CUDA analogue of the mlx runtime-adapter path (no fusing, no requant rounding).
if [[ -n "$ADAPTER" ]]; then
  ARGS+=( --enable-lora --lora-modules "${NAME}=${ADAPTER}" --max-lora-rank 32 )
  echo "== serving $MODEL + LoRA $ADAPTER as '$NAME' on :$PORT =="
else
  echo "== serving base $MODEL as '$NAME' on :$PORT =="
fi

exec python -m vllm.entrypoints.openai.api_server "${ARGS[@]}"
