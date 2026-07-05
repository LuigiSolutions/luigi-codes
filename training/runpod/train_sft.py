#!/usr/bin/env python3
"""
LoRA SFT distillation for Luigi Codes (reasoning roadmap, Phase 2).

Trains a LoRA adapter on the base coder model using filtered teacher traces
(chat-format JSONL: {"messages":[{"role":"user",...},{"role":"assistant",...}]}),
so the base learns to reason like the R1 teacher WITHOUT swapping off its strong
coding base. QLoRA (4-bit) so a 7B fits a single 24GB RTX 4090.

UNVALIDATED on hardware - the first pod run is the validation. TRL's API changes
between versions; the two most likely breakages are noted inline (search "VERSION").

Usage (on the pod, after setup.sh):
  python training/runpod/train_sft.py \
    --data training/dataset/train.jsonl \
    --base Qwen/Qwen2.5-Coder-7B-Instruct \
    --output luigi-reasoning-adapter --epochs 2

Then pull the adapter dir back to the Mac and serve it via scripts/serve-model.py,
and eval with:  npm run eval -- --difficulty expert
"""
import argparse
import json
import os

import torch
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, prepare_model_for_kbit_training
from trl import SFTConfig, SFTTrainer


def load_chat_jsonl(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"No examples in {path}. Generate + filter traces first.")
    # Keep only the 'messages' field; SFTTrainer applies the chat template itself.
    return Dataset.from_list([{"messages": r["messages"]} for r in rows])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="chat-format JSONL from filter-traces")
    ap.add_argument("--base", default="Qwen/Qwen2.5-Coder-7B-Instruct")
    ap.add_argument("--output", default="luigi-reasoning-adapter")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--max-seq-len", type=int, default=4096)
    ap.add_argument("--grad-accum", type=int, default=8)
    args = ap.parse_args()

    if not torch.cuda.is_available():
        raise SystemExit("No CUDA GPU visible. Launch a GPU pod and run setup.sh first.")

    ds = load_chat_jsonl(args.data)
    print(f"Loaded {len(ds)} training examples from {args.data}")

    tokenizer = AutoTokenizer.from_pretrained(args.base, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base,
        quantization_config=bnb,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)

    peft_config = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        # Qwen2.5 attention + MLP projections.
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )

    sft = SFTConfig(
        output_dir=args.output,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=5,
        save_strategy="epoch",
        bf16=True,
        # VERSION: TRL renamed this. <=0.11 used max_seq_length; 1.x (installed: trl 1.7)
        # uses max_length. Confirmed against the installed SFTConfig dataclass fields.
        max_length=args.max_seq_len,
        packing=False,
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        args=sft,
        train_dataset=ds,
        peft_config=peft_config,
        processing_class=tokenizer,   # VERSION: older TRL uses tokenizer=tokenizer
    )
    trainer.train()
    trainer.save_model(args.output)
    tokenizer.save_pretrained(args.output)
    print(f"\nSaved LoRA adapter to: {os.path.abspath(args.output)}")
    print("Pull it to the Mac (runpodctl send / scp), then serve base + adapter and eval.")


if __name__ == "__main__":
    main()
