#!/usr/bin/env bash
# Serves the d1-omni-600M decision model for castlegate's gate/guard (SPEC 3.1).
# Requires llama.cpp >= 0.7.0 with the /v1/systemone endpoint (llama.app or
# `brew install llama.cpp`). The ~400 MB GGUF is downloaded on first run.
set -euo pipefail
exec llama-server \
  -hf LiquidAI/d1-omni-600M-GGUF:Q8_0 \
  -b 4096 -ub 4096 \
  --port 8081 --host 127.0.0.1
