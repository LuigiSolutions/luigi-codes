# Training your own Luigi model (local, on-machine)

Luigi Codes collects a private dataset as you use it — every agent plan you
accept, and every edit you make to a file Luigi wrote — and can export it as
training-ready JSONL. You then fine-tune an open coder model **on your own Mac**
with a LoRA adapter. No cloud, no per-token cost, no data leaving the machine.

This is fine-tuning, not training from scratch: you start from a strong open
base (Qwen2.5-Coder) and teach it *your* codebase's conventions, your style, and
your past corrections. Expect a model that fits you — not one that out-reasons a
frontier model.

## 1. Collect data (just use Luigi)

Run the agent, accept good plans, and edit the files it writes. Check progress
in **Luigi: Show Agent Status** → "Self-improvement — N training pairs". A few
hundred pairs is enough for a first useful LoRA.

## 2. Export the dataset

Command Palette → **Luigi: Export Training Data (fine-tune JSONL)**. This writes
`train.jsonl` and `valid.jsonl` (chat format) into the extension's global
storage and offers to reveal the folder. Each line looks like:

```json
{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}]}
```

## 3. Fine-tune locally with MLX (Apple Silicon)

```bash
# one-time
pip install mlx-lm

# point the script at the exported folder (from step 2)
scripts/finetune-mlx.sh /path/to/finetune
```

That wraps the underlying command:

```bash
mlx_lm.lora \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --train --data /path/to/finetune \
  --iters 600 --batch-size 1 --num-layers 8 \
  --adapter-path ./luigi-adapter
```

On 16 GB RAM use a **4-bit** base (as above) and `--batch-size 1`. Training a
7B LoRA runs in roughly an hour; leave it overnight to be safe.

## 4. Try it, then keep it

```bash
# test the adapter
mlx_lm.generate --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path ./luigi-adapter --prompt "Refactor this function..."

# fuse adapter into a standalone model you can serve
mlx_lm.fuse --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path ./luigi-adapter --save-path ./luigi-coder
```

## 5. Serve it and point Luigi at it

This is the default, out of the box: `luigi.model.provider` = `custom` and
`luigi.model.endpoint` = `http://localhost:8080` ship as the extension's
defaults (`package.json`), and both the VS Code extension and the standalone
web app **auto-start this server on launch** if nothing answers at that
endpoint (`src/inference/modelServer.ts`); no manual step needed on a machine
that already has the venv + adapter (see Environment section below). Manual
invocation, if you want it running before the extension starts, or with a
different adapter:

```bash
~/.luigi-mlx/bin/python scripts/serve-model.py \
  --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
  --adapter-path ~/luigi-finetune/luigi-adapter --port 8080
```

The server speaks the OpenAI wire format, which Luigi's `custom` provider
understands natively (no Ollama required). `scripts/serve-model.py` is a thin
wrapper that forces the configured `--adapter-path` onto every request; mlx-lm's
own internal adapter-map keying has drifted across releases (last caught
2026-07-12) and silently drops the adapter, serving base-model answers with no
error. If Luigi ever starts answering like the base model again (e.g. wrong
brand color, generic answers), that map drifting again is the first suspect:
verify with a question the base model gets wrong (`eval/benchmark.jsonl` has
several) before assuming the training itself regressed.

Caveat discovered on this machine: `mlx_lm.fuse` on an already-4-bit base
produced a model WITHOUT the adapter behavior (silent no-op). Serve base +
adapter via the wrapper instead of fusing, or fuse from the fp16 base.

Alternatively convert the fused model to GGUF and `ollama create luigi-coder -f
Modelfile` if you prefer serving through Ollama (`luigi.model.provider` =
`ollama`, `luigi.model.endpoint` = `http://localhost:11434`; the extension
still supports this as a bring-your-own-model path).

**Product direction:** Luigi's own fine-tuned model is the intended brain for
every Luigi Solutions surface, not just this extension: the web app and, later,
the mobile/desktop apps all point at the same local server. **LuigiOS**
([github.com/LuigiSolutions/luigi-os](https://github.com/LuigiSolutions/luigi-os),
with the mobile client at
[luigi-os-mible-app](https://github.com/LuigiSolutions/luigi-os-mible-app)) is a
separate repo/project planned to eventually use Luigi Codes' trained model as its
underlying engine. That integration happens on the LuigiOS side, consuming this
repo's model server as a client; nothing about it lives here.

## Measuring quality (eval harness)

"Feels better" is not a metric. `eval/benchmark.jsonl` holds scored cases —
expected keywords per answer, plus forbidden strings (hallucination traps) —
and `scripts/eval-model.py` runs any base/adapter combination against it:

```bash
~/.luigi-mlx/bin/python scripts/eval-model.py --label base
~/.luigi-mlx/bin/python scripts/eval-model.py --label tuned --adapter-path ~/luigi-finetune/luigi-adapter
```

Run it before and after every retrain and keep the numbers. Add cases as you
find gaps — especially real questions the model got wrong. Deterministic
keyword scoring is crude but honest, offline, and comparable across runs.

Benchmark-design rule learned the hard way: a `forbid` string must be something
a CORRECT answer would never contain. Don't forbid a wrong value the right
answer legitimately negates ("never #D4A853") — keyword matching cannot tell
negation from assertion.

Training tip learned on this machine: with a small dataset, validation loss
bottoms out early (iter ~125 of 250 on the 36-example seed) — keep the
checkpoints (`0000100_adapters.safetensors` etc.) and eval them against the
final adapter before choosing which to serve.

## Environment used on this machine

A working setup already exists here (installed 2026-07-03):
- venv: `~/.luigi-mlx` (Python 3.12, `mlx-lm 0.31.3`, `transformers 5.12.0` —
  pinned because transformers 5.13 breaks mlx-lm's tokenizer registration)
- dataset + adapter: `~/luigi-finetune/` (seed set: Luigi identity, Luigi
  Solutions conventions, house-style code patterns; replace/augment it with
  real exported data as usage accumulates)
- invoke tools as `~/.luigi-mlx/bin/python -m mlx_lm <lora|generate|server> …`

## What it costs

- **Locally on your Mac: $0** — just electricity and a few hours.
- Renting a cloud GPU for a faster/larger run: **~$10–50** per run.
- Training a base model *from scratch* would be **$200k+** — which is exactly
  why this path fine-tunes an open model instead.
