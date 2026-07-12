#!/usr/bin/env python3
"""Luigi Codes — serve the tuned model over an OpenAI-compatible API.

Thin wrapper around `mlx_lm.server` that fixes an upstream bug: ModelProvider.load()
resolves the request's model name against an internal adapter map whose keying
has drifted across mlx-lm releases, so `--adapter-path` gets silently dropped on
every request and the server answers with the base model. Since this process
always serves exactly one model + adapter pair (fixed at startup), we skip the
map entirely and force the configured adapter path onto every load.

Usage (mirrors mlx_lm.server):
  ~/.luigi-mlx/bin/python scripts/serve-model.py \
    --model mlx-community/Qwen2.5-Coder-7B-Instruct-4bit \
    --adapter-path ~/luigi-finetune/luigi-adapter --port 8080

Remove this wrapper once upstream fixes the lookup order.
"""
import sys

from mlx_lm.server import ModelProvider, main

_original_load = ModelProvider.load


def _configured_adapter_path():
    argv = sys.argv
    for i, token in enumerate(argv):
        if token == '--adapter-path' and i + 1 < len(argv):
            return argv[i + 1]
    return None


_ADAPTER_PATH = _configured_adapter_path()


def _load_with_adapter(self, model_path, adapter_path=None, draft_model_path=None):
    return _original_load(self, model_path, adapter_path or _ADAPTER_PATH, draft_model_path)


ModelProvider.load = _load_with_adapter

if __name__ == "__main__":
    sys.exit(main())
