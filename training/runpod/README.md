# RunPod pod kit: LoRA SFT distillation

Turnkey-ish scripts to distill R1 reasoning into the Qwen2.5-Coder base on a rented
GPU, then bring the adapter home and serve it locally. On-demand GPUs are billed by
the hour, so the flow is: prep data locally (free) -> spin up -> train -> pull adapter
-> spin down. Target one **RTX 4090 24GB** (QLoRA 7B fits); a proof run is a few dollars.

> Status: VALIDATED on a real RTX 4090 (2026-07-04). torch 2.8.0+cu128, transformers 5.13,
> trl 1.7.1, peft 0.19.1. First run needed one fix (SFTConfig max_seq_length -> max_length,
> already applied) and the PEP 668 pip flag (in setup.sh). Result: hard coding held 6/6,
> expert reasoning 31 -> 35 / 40 (+4), ~$1. See section 6.

## 0. Prep the dataset (locally, $0 - do this before renting)

The training data is filtered teacher traces. It is gitignored, so it does NOT ride
the repo to the pod - you produce it, then upload it (step 3).

```bash
# generate traces from a teacher, then rejection-sample into training/dataset/
npm run gen:traces -- --model <teacher> --endpoint <url>   # e.g. full R1 API, or local R1 for a proof
npm run filter:traces                                       # -> training/dataset/train.jsonl + valid.jsonl
```

For real quality, the teacher should be **full DeepSeek-R1** (API or self-hosted) or an
open R1 trace dataset - not the local 7B distill (that's only good enough to prove the
loop). See `docs/REASONING_ROADMAP.md`.

## 1. Launch the pod

RunPod console -> Deploy -> **RTX 4090 (24GB)**, template **RunPod PyTorch 2.x**,
On-Demand. Open the web terminal (or SSH).

## 2. Get the code on the pod

```bash
git clone https://github.com/LuigiSolutions/luigi-codes
cd luigi-codes
bash training/runpod/setup.sh
```

## 3. Get the dataset on the pod

The dataset is not in git. Move `training/dataset/train.jsonl` from the Mac using
`runpodctl` (needs your RunPod API key: `runpodctl config --apiKey <KEY>`):

```bash
# on the Mac:
runpodctl send training/dataset/train.jsonl
# on the pod (paste the code runpodctl printed):
runpodctl receive <code>
mkdir -p training/dataset && mv train.jsonl training/dataset/
```

(Alternatives: scp, or a private HuggingFace dataset.)

## 4. Train

Validated hyperparams (conservative, to protect coding: 1 epoch + low LR held coding at
6/6 while reasoning rose +4). 524 examples, rank 16, ~13 min on a 4090:

```bash
export PIP_BREAK_SYSTEM_PACKAGES=1 HF_HOME=/workspace/hf
python training/runpod/train_sft.py \
  --data training/dataset/train.jsonl \
  --base Qwen/Qwen2.5-Coder-7B-Instruct \
  --output /workspace/luigi-reasoning-adapter --epochs 1 --lr 1e-4 --rank 16
```

Terminate the pod the INSTANT training + adapter pull are done (idle pod time is wasted
spend; the first run cost ~$1 of GPU but sat idle a while before teardown).

## 5. Bring the adapter home + spin down

```bash
# on the pod:
runpodctl send luigi-reasoning-adapter
# on the Mac:
runpodctl receive <code>            # -> ~/luigi-finetune/luigi-reasoning-adapter
```

**Stop the pod in the console** the moment training + transfer are done (billing stops).

## 6. Eval the adapter (the gate) - VALIDATED FLOW (2026-07-04)

The rigorous, apples-to-apples comparison is **on the pod at fp16**: serve the base and
the base+adapter on the SAME server (no quantization mismatch) and score both with the
real harness over an SSH tunnel. `serve_hf.py` is transformers-only (no vLLM, no torch
version fight):

```bash
# ON THE POD (one at a time; ~15GB VRAM each):
python training/runpod/serve_hf.py --base Qwen/Qwen2.5-Coder-7B-Instruct --port 8000            # base
python training/runpod/serve_hf.py --base Qwen/Qwen2.5-Coder-7B-Instruct \
  --adapter /workspace/luigi-reasoning-adapter --port 8000                                       # base+adapter

# ON THE MAC: tunnel + eval each with the real harness
ssh -N -L 8099:localhost:8000 root@<pod-ip> -p <port> -i ~/.ssh/id_ed25519 &
npm run eval -- --difficulty expert --temperature 0 --endpoint http://localhost:8099 --timeout 300000
npm run eval -- --suite coding --difficulty hard --temperature 0 --endpoint http://localhost:8099 --timeout 300000
```

First validated run: hard coding held **6/6**, expert reasoning **31 -> 35 / 40 (+4)**.
Promote only if coding holds 6/6 AND expert gains >= 2 (deterministic at temp 0).

### Local 4-bit deployment (what the product serves)

The adapter is PEFT format; the product serves mlx 4-bit. Convert then serve the adapter
**at runtime** (do NOT fuse+requantize, see finding):

```bash
# convert PEFT -> mlx adapter format (transpose + scale=alpha/r), then serve base+adapter
~/.luigi-mlx/bin/python scripts/peft_to_mlx_adapter.py \
  --in ~/luigi-finetune/luigi-reasoning-adapter --out ~/luigi-finetune/luigi-reasoning-adapter-mlx
~/.luigi-mlx/bin/python scripts/serve_mlx_adapter.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path ~/luigi-finetune/luigi-reasoning-adapter-mlx --port 8081
npm run eval -- --difficulty expert --temperature 0 --endpoint http://localhost:8081 --model luigi-candidate --timeout 300000
```

> **Finding (validated):** `mlx_lm fuse` merges the LoRA into the 4-bit base and
> re-quantizes, which rounds the small LoRA deltas away (sub-4-bit-resolution) - the fused
> model behaves like the base. And `scripts/serve-model.py` (mlx_lm.server wrapper) silently
> drops `--adapter-path`. So for 4-bit you MUST serve base + adapter at runtime via
> `serve_mlx_adapter.py` (standard QLoRA serving, fp16 LoRA on the 4-bit base), which
> preserves the gain. Confirmed: it reaches the trained answers the base misses.
