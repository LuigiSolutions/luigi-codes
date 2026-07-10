# iter-A40-2 (lr 2e-5): PROMOTED reasoning adapter

First CUDA-trained LoRA that lifts reasoning with zero regression. PROMOTE (2026-07-10, A40 bf16).

## Recipe
- base: `Qwen/Qwen2.5-Coder-7B-Instruct` (bf16)
- data: `training/dataset-iter2-concise` (567 math-reasoning R1 traces)
- LoRA: r=8, alpha=16, last-8-layers (20..27 of 28), 7 modules (attn+MLP), completion-only mask
- **lr 2e-5** (the fix: iter-A40-1 used 1e-4, ~10x too high, and collapsed reasoning 30->18)
- 1 epoch, grad-accum 4, final train_loss ~0.70
- trainer: `scripts/finetune_cuda.py`

## Eval vs A40 base (same env, temp 0, verifier v2)
| suite | base | adapter | gate |
|---|---|---|---|
| coding | 27/27 | 27/27 | == 27/27 ✅ |
| reasoning_code | 22/23 | 22/23 | >= 22 ✅ |
| reasoning (single) | 30/40 | 32/40 | > 30 ✅ |
| reasoning (+M1 code) | n/a | 35/40 | clears 33 bar |

## Files
- `adapter_config.json` (tracked)
- `adapter_model.safetensors`: 23MB, gitignored; lives on pod `/workspace/adapter-iter2-lr2e5` + this local backup
- serve: `python serve_hf_cuda.py --model Qwen/Qwen2.5-Coder-7B-Instruct --adapter-path <dir> --name luigi-candidate`
