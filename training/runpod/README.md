# RunPod pod kit: LoRA SFT distillation

Turnkey-ish scripts to distill R1 reasoning into the Qwen2.5-Coder base on a rented
GPU, then bring the adapter home and serve it locally. On-demand GPUs are billed by
the hour, so the flow is: prep data locally (free) -> spin up -> train -> pull adapter
-> spin down. Target one **RTX 4090 24GB** (QLoRA 7B fits); a proof run is a few dollars.

> Honest note: this kit is written to standard TRL/PEFT patterns but has NOT run on
> a GPU yet. Treat the first run as validation - expect to pin a version or tweak an
> argument (the two likely spots are marked `VERSION` in `train_sft.py`).

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

```bash
python training/runpod/train_sft.py \
  --data training/dataset/train.jsonl \
  --base Qwen/Qwen2.5-Coder-7B-Instruct \
  --output luigi-reasoning-adapter --epochs 2
```

## 5. Bring the adapter home + spin down

```bash
# on the pod:
runpodctl send luigi-reasoning-adapter
# on the Mac:
runpodctl receive <code>            # -> ~/luigi-finetune/luigi-reasoning-adapter
```

**Stop the pod in the console** the moment training + transfer are done (billing stops).

## 6. Serve + eval locally (the gate)

```bash
~/.luigi-mlx/bin/python scripts/serve-model.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path ~/luigi-finetune/luigi-reasoning-adapter --port 8080

# compare to the pre-training baselines:
npm run eval -- --difficulty expert    # baseline coder ~9/10; want this UP
npm run eval -- --suite coding --difficulty hard   # baseline 6/6; must NOT regress
```

Promote the adapter only if expert reasoning improves and hard coding holds at 6/6.
Keep the numbers. Then iterate (more/better traces), and later add DPO / GRPO.

> Caveat: the adapter is trained on the HF fp16 base (`Qwen/Qwen2.5-Coder-7B-Instruct`)
> but served on the mlx 4-bit base. That usually works but is not guaranteed identical;
> if behavior looks off, serve via the HF base on the pod for the eval instead, or
> convert. Validate on first run.
