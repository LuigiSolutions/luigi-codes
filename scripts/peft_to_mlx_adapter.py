#!/usr/bin/env python3
"""
Convert a PEFT/TRL LoRA adapter (from training/runpod/train_sft.py) into mlx-lm's
adapter format, so it can be fused into the mlx 4-bit base the product serves.

Why: the pod trains QLoRA with PEFT (adapter_model.safetensors, keys like
base_model.model.model.layers.N.self_attn.q_proj.lora_A.weight, A=[r,in] B=[out,r]).
mlx-lm expects adapters.safetensors with keys model.layers.N.self_attn.q_proj.lora_a
([in,r]) / lora_b ([r,out]) plus an adapter_config.json describing rank/scale/keys.
The math matches once A,B are transposed and scale=alpha/r is carried in the config
(mlx applies scale at fuse time, same as PEFT's alpha/r).

Usage:
  python scripts/peft_to_mlx_adapter.py \
    --in ~/luigi-finetune/luigi-reasoning-adapter \
    --out ~/luigi-finetune/luigi-reasoning-adapter-mlx
Then:
  python -m mlx_lm fuse --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --adapter-path <out> --save-path <fused-4bit-dir>
"""
import argparse
import json
import os

import mlx.core as mx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True, help="PEFT adapter dir")
    ap.add_argument("--out", dest="out", required=True, help="mlx adapter dir to write")
    args = ap.parse_args()

    with open(os.path.join(args.inp, "adapter_config.json")) as f:
        pcfg = json.load(f)
    r = int(pcfg["r"])
    alpha = int(pcfg["lora_alpha"])
    scale = alpha / r
    targets = sorted(pcfg["target_modules"])  # e.g. q_proj, k_proj, ...

    weights = mx.load(os.path.join(args.inp, "adapter_model.safetensors"))
    out = {}
    n_a = n_b = 0
    for k, v in weights.items():
        # base_model.model.model.layers.N.<sub>.<proj>.lora_A.weight -> model...lora_a
        key = k.replace("base_model.model.", "")
        if key.endswith(".lora_A.weight"):
            out[key[: -len(".lora_A.weight")] + ".lora_a"] = mx.transpose(v)  # [r,in]->[in,r]
            n_a += 1
        elif key.endswith(".lora_B.weight"):
            out[key[: -len(".lora_B.weight")] + ".lora_b"] = mx.transpose(v)  # [out,r]->[r,out]
            n_b += 1
        else:
            raise SystemExit(f"Unexpected adapter key: {k}")
    if n_a != n_b:
        raise SystemExit(f"lora_a ({n_a}) != lora_b ({n_b}) count")

    # keys are per-layer module paths; map bare proj names to their parent module.
    parent = {
        "q_proj": "self_attn", "k_proj": "self_attn", "v_proj": "self_attn", "o_proj": "self_attn",
        "gate_proj": "mlp", "up_proj": "mlp", "down_proj": "mlp",
    }
    keys = sorted({f"{parent[t]}.{t}" for t in targets})
    # num_layers: highest layer index that has an adapter, + 1 (covers all trained layers).
    layer_ids = [int(k.split("layers.")[1].split(".")[0]) for k in out if "layers." in k]
    num_layers = max(layer_ids) + 1 if layer_ids else 0

    os.makedirs(args.out, exist_ok=True)
    mx.save_safetensors(os.path.join(args.out, "adapters.safetensors"), out)
    mlx_cfg = {
        "fine_tune_type": "lora",
        "num_layers": num_layers,
        "lora_parameters": {"rank": r, "scale": scale, "dropout": 0.0, "keys": keys},
    }
    with open(os.path.join(args.out, "adapter_config.json"), "w") as f:
        json.dump(mlx_cfg, f, indent=2)

    print(f"Converted {n_a} lora_a + {n_b} lora_b tensors -> {args.out}")
    print(f"  rank={r} alpha={alpha} scale={scale}  num_layers={num_layers}")
    print(f"  keys={keys}")


if __name__ == "__main__":
    main()
