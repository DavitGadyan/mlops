#!/usr/bin/env bash
# Score the running engine on gsm8k with lm-eval, through its chat endpoint.
#   bench/eval.sh <target> <engine-url>        (normally via `make eval`)
set -euo pipefail

target=$1 url=$2

# gsm8k is generative: the model writes its reasoning and a final number. That
# makes it runnable over chat completions, exactly as a client would call the
# engine, and it is sensitive to the small errors quantization introduces. The
# task itself fixes temperature 0.
# tokenized_requests=False: send text and let the engine apply its own chat
# template and tokenizer, since that path is part of what is being validated.
uvx --python 3.12 --from "lm_eval[api]==0.4.13" lm-eval run \
  --model local-chat-completions \
  --model_args "model=qwen7b,base_url=$url/v1/chat/completions,num_concurrent=${EVAL_CONCURRENCY:-8},max_retries=3,tokenized_requests=False" \
  --tasks gsm8k --apply_chat_template --limit "${EVAL_LIMIT:-500}" \
  --output_path "results/raw/$target/eval"
