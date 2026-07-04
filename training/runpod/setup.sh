#!/usr/bin/env bash
# Pod bootstrap for Luigi Codes LoRA SFT distillation.
# Run once on a fresh RunPod "PyTorch 2.x" pod (torch + CUDA already present).
# UNVALIDATED on hardware yet - the first pod run is the validation. TRL/PEFT APIs
# shift between releases; if train_sft.py errors on an argument, pin versions or
# adjust to the installed TRL (see training/runpod/README.md).
set -euo pipefail

echo "== Luigi pod setup =="
pip install -q --upgrade pip
# The training stack. Versions are a known-good floor; bump/pin if TRL's API differs.
pip install -q \
  "transformers>=4.44" \
  "datasets>=2.20" \
  "peft>=0.12" \
  "trl>=0.11" \
  "bitsandbytes>=0.43" \
  "accelerate>=0.33"

python - <<'PY'
import torch
ok = torch.cuda.is_available()
print("CUDA available:", ok)
if ok:
    print("GPU:", torch.cuda.get_device_name(0))
    print("VRAM GB:", round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1))
else:
    print("WARNING: no CUDA GPU visible - are you on a GPU pod?")
PY

echo "== setup done. Next: python training/runpod/train_sft.py --help =="
