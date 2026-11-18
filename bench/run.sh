#!/usr/bin/env bash
# Load-test the running engine with AIPerf and keep the raw results.
#   bench/run.sh <target> <engine-url>        (normally via `make bench`)
set -euo pipefail

target=$1 url=$2
out=results/raw/$target
mkdir -p "$out"

profile() {
  # ignore_eos with a fixed output length makes every request generate exactly
  # $OSL tokens, so engines are compared on the same amount of work.
  # --no-server-metrics: AIPerf would scrape <url>/metrics, which on trtllm-serve
  # empties the engine's stats queue. Prometheus collects engine metrics instead.
  uvx --python 3.12 aiperf@0.13.0 profile \
    --model qwen7b --tokenizer Qwen/Qwen2.5-7B-Instruct \
    --url "$url" --endpoint-type chat --streaming \
    --isl "$ISL" --osl "$OSL" --extra-inputs ignore_eos:true \
    --goodput "time_to_first_token:$SLO_TTFT_MS inter_token_latency:$SLO_ITL_MS" \
    --random-seed 7 --no-server-metrics --no-gpu-telemetry --ui none "$@"
}

# What was measured, on what: the GPU, and the size of the weights on disk.
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader >"$out/gpu.csv"
model=$(grep -hE '^(TRTLLM|VLLM)_MODEL=' "engines/$target.env" | cut -d= -f2-)
case $model in
  /models/*) weights=${MODELS_DIR:-models}/${model#/models/} ;;
  *) weights=${HF_CACHE:-$HOME/.cache/huggingface}/hub/models--${model//\//--}/snapshots ;;
esac
du -sLk "$weights" | cut -f1 >"$out/weights_kib.txt"

# Closed loop: hold N requests in flight and see where throughput stops scaling
# and latency leaves the SLO. Low levels get at least 50 requests for stable tails.
for concurrency in ${LEVELS:-1 2 4 8 16 32}; do
  profile --concurrency "$concurrency" \
    --warmup-request-count "$concurrency" \
    --request-count $((concurrency * 10 > 50 ? concurrency * 10 : 50)) \
    --artifact-dir "$out/c$concurrency"
done

# Open loop at 70% of the peak just measured. Arrivals follow a Poisson clock and
# do not wait for earlier requests, so queueing shows up in the latency instead
# of being hidden by a client that slows down with the server.
rate=$(python3 -c '
import glob, json, sys
peak = max(json.load(open(f))["request_throughput"]["avg"] for f in glob.glob(sys.argv[1] + "/c*/profile_export_aiperf.json"))
print(round(0.7 * peak, 2))' "$out")
profile --request-rate "$rate" --arrival-pattern poisson --benchmark-duration 120 --artifact-dir "$out/open"
echo "$rate" >"$out/open/rate_rps.txt"
