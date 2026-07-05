#!/usr/bin/env bash
# Pod bootstrap for Luigi Codes LoRA SFT distillation.
# Run once on a fresh RunPod "PyTorch 2.x" pod (torch + CUDA already present).
# UNVALIDATED on hardware yet - the first pod run is the validation. TRL/PEFT APIs
# shift between releases; if train_sft.py errors on an argument, pin versions or
# adjust to the installed TRL (see training/runpod/README.md).
set -euo pipefail

echo "== Luigi pod setup =="
# RunPod's PyTorch images mark the system Python PEP 668 "externally managed", so pip
# refuses to install without this. The pod is disposable, so breaking system packages is fine.
export PIP_BREAK_SYSTEM_PACKAGES=1
pip install -q --upgrade pip
# The training stack. These EXACT versions were validated end-to-end on an RTX 4090 with
# torch 2.8.0+cu128 (2026-07-04); train_sft.py is written against this TRL API (SFTConfig
# uses max_length, SFTTrainer uses processing_class). If RunPod ships a different torch and
# these conflict, relax to floors and re-check the two VERSION spots in train_sft.py.
pip install -q \
  "transformers==5.13.0" \
  "datasets==5.0.0" \
  "peft==0.19.1" \
  "trl==1.7.1" \
  "bitsandbytes==0.49.2" \
  "accelerate==1.14.0"

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
