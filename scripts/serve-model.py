#!/usr/bin/env python3
"""Luigi Codes — serve the tuned model over an OpenAI-compatible API.

Thin wrapper around `mlx_lm.server` that fixes an upstream bug (mlx-lm 0.31.x):
ModelProvider.load() resolves the request's model name BEFORE consulting the
adapter map, which is keyed only by "default_model" — so `--adapter-path` is
silently dropped on every request and the server answers with the base model.
We look the adapter up with the ORIGINAL key first, then delegate.

Usage (mirrors mlx_lm.server):
  ~/.luigi-mlx/bin/python scripts/serve-model.py \
    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --adapter-path ~/luigi-finetune/luigi-adapter --port 8080

Remove this wrapper once upstream fixes the lookup order.
"""
import sys

from mlx_lm.server import ModelProvider, main

_original_load = ModelProvider.load

def _load_with_adapter(self, model_path, adapter_path=None, draft_model_path=None):
    # Resolve the adapter with the UNRESOLVED model key ("default_model");
    # the original then keeps this value because its own map lookup misses.
    adapter_path = self._adapter_map.get(model_path, adapter_path)
    return _original_load(self, model_path, adapter_path, draft_model_path)

ModelProvider.load = _load_with_adapter

if __name__ == "__main__":
    sys.exit(main())
