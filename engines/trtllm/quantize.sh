#!/usr/bin/env bash
# Quantize Qwen2.5-7B-Instruct with NVIDIA ModelOpt into a Hugging Face
# checkpoint that TensorRT-LLM and vLLM both load directly. Runs inside the
# TensorRT-LLM image, which already ships ModelOpt and a matching PyTorch.
#
#   make quantize QFORMAT=fp8        8-bit float weights and activations
#   make quantize QFORMAT=int4_awq   4-bit AWQ weights, 16-bit activations
set -euo pipefail

qformat=${1:?usage: quantize.sh <fp8|int4_awq>}
extra=()

# FP8 calibration only collects min/max ranges, so ModelOpt can compress the
# weights first and calibrate inside 16 GB. AWQ searches per-layer scales
# against full-precision activations and has no such mode: it needs the 15 GB
# BF16 model in memory, so on a 16 GB card it spills to host RAM and is slow.
[[ $qformat == fp8 ]] && extra+=(--low_memory_mode)

# Use the example script from the same release as the installed library.
version=$(python -c "import modelopt; print(modelopt.__version__)")
git clone --quiet --depth 1 --branch "$version" https://github.com/NVIDIA/Model-Optimizer /tmp/modelopt
cd /tmp/modelopt/examples/hf_ptq

# --kv_cache_qformat none: leave the KV cache in BF16, so an accuracy change
# can be attributed to the weights alone. (The default also casts the cache to FP8.)
python hf_ptq.py \
  --pyt_ckpt_path Qwen/Qwen2.5-7B-Instruct \
  --qformat "$qformat" \
  --kv_cache_qformat none \
  --calib_size 512 \
  --export_path "/models/qwen2.5-7b-$qformat" \
  "${extra[@]}"
