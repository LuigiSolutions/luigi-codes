#!/usr/bin/env python3
"""
CUDA LoRA SFT for the Luigi reasoning adapter (RunPod, the training must NOT run on the Mac).
The Apple-only recipe is scripts/finetune-mlx.sh; this is its CUDA twin using transformers + peft +
trl. Trains a LoRA on chat-format reasoning traces (messages: user -> assistant-with-<think>).

Recipe mirrors the GENTLE local recipe that lifted reasoning WITHOUT regressing coding: LoRA on the
last N transformer layers only (mlx --num-layers 8), ~1 epoch, modest lr. Stronger pod recipes
(rank 16, 2 epochs, all layers) previously overwrote the coding behavior -> DO-NOT-PROMOTE.

Completion-only loss (train on the assistant answer, not the prompt) via the Qwen response template,
matching mlx --mask-prompt. bf16 + gradient checkpointing to fit the 7B + LoRA on a 48GB card.

Usage:
  HF_HOME=/workspace/hf python scripts/finetune_cuda.py \
    --data training/dataset-iter2-concise --out /workspace/adapter-iter2 \
    --model Qwen/Qwen2.5-Coder-7B-Instruct --epochs 1 --lr 1e-4 --rank 8 --last-layers 8
"""
import argparse
import json
import os

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig, DataCollatorForCompletionOnlyLM


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--data", required=True, help="dir with train.jsonl (+ optional valid.jsonl)")
    ap.add_argument("--out", required=True, help="adapter output dir")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=8)
    ap.add_argument("--alpha", type=int, default=16)
    ap.add_argument("--last-layers", type=int, default=8, help="apply LoRA only to the last N layers (0 = all)")
    ap.add_argument("--max-seq", type=int, default=2048)
    ap.add_argument("--grad-accum", type=int, default=4)
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="cuda", use_cache=False
    )

    # Restrict LoRA to the last N layers (the gentle recipe: enough to shift reasoning style without
    # overwriting coding behavior). Qwen2.5-7B has 28 layers.
    n_layers = model.config.num_hidden_layers
    layers_to_transform = None
    if args.last_layers and args.last_layers < n_layers:
        layers_to_transform = list(range(n_layers - args.last_layers, n_layers))
    lora = LoraConfig(
        r=args.rank, lora_alpha=args.alpha, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        layers_to_transform=layers_to_transform,
    )
    print(f"LoRA r={args.rank} alpha={args.alpha} on "
          f"{'layers ' + str(layers_to_transform) if layers_to_transform else 'ALL layers'} of {n_layers}", flush=True)

    # Chat-format traces -> a `text` field with the chat template applied; the collator masks the
    # prompt so loss is on the assistant answer only.
    train = load_dataset("json", data_files=os.path.join(args.data, "train.jsonl"), split="train")

    def to_text(ex):
        return {"text": tok.apply_chat_template(ex["messages"], tokenize=False)}
    train = train.map(to_text, remove_columns=train.column_names)

    # Qwen assistant turn begins after this marker; mask everything up to and including it.
    collator = DataCollatorForCompletionOnlyLM(response_template="<|im_start|>assistant\n", tokenizer=tok)

    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        logging_steps=10,
        save_strategy="no",
        max_seq_length=args.max_seq,
        packing=False,
        dataset_text_field="text",
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model, args=cfg, train_dataset=train,
        processing_class=tok, peft_config=lora, data_collator=collator,
    )
    print(f"Training on {len(train)} examples, {args.epochs} epoch(s)...", flush=True)
    trainer.train()
    trainer.save_model(args.out)
    tok.save_pretrained(args.out)
    print(f"DONE. Adapter saved to {args.out}", flush=True)


if __name__ == "__main__":
    main()
