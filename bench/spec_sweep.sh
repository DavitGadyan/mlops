#!/usr/bin/env bash
# Speculative decoding: draft length x concurrency, on real prompts.
#   bench/spec_sweep.sh        (normally via `make spec-sweep`)
#
# Draft length 0 is the same engine without speculation, the baseline every
# speed-up is measured against. The engine is restarted for each draft length.
set -euo pipefail

url=http://localhost:8001
out=results/raw/spec

# Sum of one Prometheus counter over its label sets.
counter() {
  curl -fsS "$url/prometheus/metrics" | awk -v name="$1" 'index($1, name) == 1 {sum += $NF} END {printf "%d", sum}'
}

for draft in 0 2 4 6; do
  if ((draft == 0)); then
    make up ENGINE=trtllm-fp8
  else
    DRAFT_LEN=$draft make up ENGINE=trtllm-fp8-spec
  fi

  for concurrency in 1 4 16; do
    run=$out/d${draft}_c$concurrency
    drafted=$(counter trtllm_spec_decode_num_draft_tokens_total)
    accepted=$(counter trtllm_spec_decode_num_accepted_tokens_total)

    # Spec-Bench: real prompts from chat, translation, summarisation, QA, maths
    # and RAG. Acceptance depends on how predictable the text is, so the random
    # tokens of a synthetic load would say nothing. The seed fixes which prompts
    # are sent, so every draft length sees the same ones at a given concurrency.
    uvx --python 3.12 aiperf@0.13.0 profile \
      --model qwen7b --tokenizer Qwen/Qwen2.5-7B-Instruct \
      --url "$url" --endpoint-type chat --streaming \
      --public-dataset spec_bench --extra-inputs max_tokens:256 temperature:0 \
      --concurrency "$concurrency" \
      --request-count $((concurrency * 24 > 96 ? concurrency * 24 : 96)) \
      --random-seed 7 --no-server-metrics --no-gpu-telemetry --ui none \
      --artifact-dir "$run"

    # Acceptance for this run alone: counter growth while it ran.
    echo "$(($(counter trtllm_spec_decode_num_draft_tokens_total) - drafted))" \
      "$(($(counter trtllm_spec_decode_num_accepted_tokens_total) - accepted))" >"$run/draft_tokens.txt"
  done
done
