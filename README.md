# qwen7b serving

Qwen2.5-7B-Instruct served on one 16 GB GPU by two engines, TensorRT-LLM and vLLM, behind one
OpenAI-compatible gateway. The repo measures what each optimisation buys and what it costs:
quantization against accuracy, speculative decoding against concurrency, and throughput against
latency under load.

```
browser ── Next.js UI ── /api/* (adds the API key server-side)
                             │
                      FastAPI gateway        auth, engine routing by model name,
                        │         │          byte-for-byte streaming, cancellation
            trtllm-serve :8001   vLLM :8002  one at a time on 16 GB
                        └────┬────┘
   Prometheus ── engine metrics + dcgm-exporter ── Grafana
```

It runs two ways: Docker Compose on one GPU host, or a Helm chart on Kubernetes, where each engine
is a set of replicas and the gateway sends every request to the least busy one.

## Status

Built and tested without a GPU: the gateway, the UI, the compose stack (gateway, UI, Prometheus and
Grafana started; all six engine targets render), the Grafana dashboard, and the parser that turns
benchmark output into the UI's data file. The Helm chart was installed on a local kind cluster with
the fake engine in place of the GPU engines: eight concurrent streams split four and four over two
replicas, and scaling to three and to zero replicas was picked up without restarting the gateway.

**Not yet run on a GPU:** the engines, quantization, the benchmarks and the accuracy runs. `results/`
is empty, and the Benchmarks page says so until `make summary` has real output to show. The five
engine conformance tests are written for a real engine; only the two streaming ones have run, against
the fake. See [Open questions](#open-questions-for-the-first-gpu-run).

## Run it

Without a GPU, against a fake engine that says it is fake:

```bash
make dev      # http://localhost:3411
make test
```

On the GPU host (Ubuntu, NVIDIA driver 580 or newer, Docker with the NVIDIA Container Toolkit, `uv`):

```bash
cp .env.example .env                 # set API_KEY
make up ENGINE=vllm-awq              # UI on :3000, Grafana on :3001
make quantize QFORMAT=fp8            # writes models/qwen2.5-7b-fp8
make up ENGINE=trtllm-fp8
make conformance bench eval ENGINE=trtllm-fp8
make spec-sweep                      # restarts the engine per draft length
make summary                         # results/summary.json, shown on the Benchmarks page
```

On Kubernetes (GPU nodes with the NVIDIA device plugin or GPU Operator):

```bash
docker build -t $REGISTRY/qwen7b-gateway:0.1.0 gateway && docker push $REGISTRY/qwen7b-gateway:0.1.0
docker build -t $REGISTRY/qwen7b-ui:0.1.0 ui && docker push $REGISTRY/qwen7b-ui:0.1.0

helm install qwen7b chart \
  --set apiKey=$(openssl rand -hex 16) \
  --set images.gateway=$REGISTRY/qwen7b-gateway:0.1.0 \
  --set images.ui=$REGISTRY/qwen7b-ui:0.1.0 \
  --set models.existingClaim=models \
  --set engines.trtllm.replicas=3
```

`models` is a ReadWriteMany claim that already holds the checkpoint from `make quantize`; without a
claim, set `engines.trtllm.model` to a Hugging Face id. `chart/values.yaml` lists every setting: which engines run and with how many replicas, the
checkpoint, speculative decoding, the shared models volume, GPU node selection, ingress, and
metric scraping. `make chart` lints it and validates the rendered manifests.

| Target | Engine | Weights | What it answers |
|---|---|---|---|
| `vllm-awq` | vLLM | published 4-bit AWQ | the starting point |
| `vllm-fp8` | vLLM | ModelOpt FP8 | engine against engine on identical weights |
| `trtllm-fp8` | TensorRT-LLM | ModelOpt FP8 | same |
| `trtllm-awq` | TensorRT-LLM | ModelOpt 4-bit AWQ | FP8 against 4-bit: speed, size, accuracy |
| `trtllm-fp8-spec` | TensorRT-LLM | FP8 + 0.5B draft model | speculative decoding |
| `vllm-bf16` | vLLM | unquantized | accuracy reference only |

**The engine switch.** A request for `qwen7b` goes to the default engine (`DEFAULT_ENGINE` in `.env`,
or whichever engine `make up` started). `trtllm/qwen7b` and `vllm/qwen7b` pick one explicitly, and
the UI's Settings panel does the same with a live running / not running status.

## Decisions and why

**The gateway relays bytes and never parses the stream.** Chunk shape, the usage block and `[DONE]`
are the engine's job; a proxy that re-encodes them can only break them. A test compares the relayed
stream with the engine's, byte for byte.

**Cancellation is end to end.** Pressing Stop aborts the browser request, the gateway closes its
engine connection, and the engine frees the batch slot and KV cache. A test asserts the engine saw
it; the conformance suite asserts the engine's running-request count returns to zero.

**16 GB decides the design.** The BF16 weights are 15.2 GB, so the unquantized model cannot be
served on this card at all. Quantization is what makes the deployment possible, and every byte it
frees becomes KV cache, which is what bounds concurrency (about 56 KiB per token for this model).

**Quantization is validated, not assumed.** `quantize.sh` leaves the KV cache in BF16 so an accuracy
change can be attributed to the weights. Accuracy is gsm8k through the chat endpoint, 500 questions,
reported with its standard error, and the UI marks a difference smaller than two combined standard
errors as noise.

**Load tests are closed loop, then open loop.** The closed-loop sweep finds where throughput stops
scaling. The open-loop run at 70% of that peak sends Poisson arrivals that do not wait for earlier
requests, because a closed loop slows its own arrivals when the server slows and so hides queueing.
Output length is fixed (`ignore_eos`) so engines do the same work. Goodput counts requests inside
the SLO (500 ms to first token, 50 ms between tokens).

**Inter-token latency comes from the usage block**, `(last − first token time) / (tokens − 1)`, the
same definition AIPerf uses. Counting SSE chunks is wrong: one chunk can carry several tokens, and
under speculative decoding it usually does.

**Speculative decoding is swept against concurrency.** Drafting spends GPU time on tokens that may be
rejected, which pays off when the GPU is idle and costs throughput when it is full. The sweep uses
Spec-Bench prompts (acceptance depends on the text) and reads acceptance from the engine's own
counters. Its result is meant to become a `draft_len_schedule`, TensorRT-LLM's per-batch-size draft
length.

**On Kubernetes, load is balanced per request, by load.** A Service balances per TCP connection,
which says nothing about load when one request can stream for minutes. The engines sit behind a
headless Service, so DNS lists the ready pods, and the gateway picks the one with the fewest requests
in flight (`gateway/app/balancer.py`). Because DNS only lists ready pods, a replica that is still
loading its checkpoint gets no traffic, and scaling needs no gateway restart.

**The chart encodes what is different about GPU pods.** Rollouts free a GPU before starting the
replacement pod (`maxSurge: 0`), since a spare GPU rarely exists. A startup probe allows minutes for
loading the checkpoint. There is no liveness probe: under heavy load `/health` answers slowly, and
restarting a busy engine turns a slowdown into an outage. Pods get two minutes to finish streaming
before they are killed.

**`engines/trtllm/base.yaml` explains each runtime setting**: KV cache share, prefix caching, chunked
prefill, batch limits. The Grafana dashboard has a panel for each question they raise: compute
against memory-controller utilisation, KV cache in use, queue time, prefill against decode time,
prefix-cache hits, draft acceptance.

## Where things are

| Topic | Files |
|---|---|
| Engines and their flags | `compose.yaml`, `engines/` |
| Kubernetes deployment and replica balancing | `chart/`, `gateway/app/balancer.py` |
| Quantization | `engines/trtllm/quantize.sh` |
| OpenAI conformance | `gateway/app/proxy.py`, `gateway/tests/test_conformance_live.py` |
| Load benchmarking | `bench/run.sh`, `ui/lib/stream.ts` |
| Accuracy evaluation | `bench/eval.sh`, `bench/summarize.py` |
| Speculative decoding | `engines/trtllm-fp8-spec.env`, `bench/spec_sweep.sh` |
| GPU and engine observability | `observability/` |

## Version notes (checked 2026-11-18)

- **TensorRT-LLM no longer compiles TensorRT engines.** `trtllm-build` was removed after 1.3.0rc20;
  the PyTorch backend is the only one, and `trtllm-serve` loads a Hugging Face checkpoint directly.
  The last stable release is 1.2.1 (April 2026). This repo pins `1.4.0rc4` for its KV-cache and
  speculative-decoding metrics. Falling back to 1.2.1 means editing the `trtllm` command in
  `compose.yaml`: that release has no `--served_model_name` or `--set`, and spells the drafter
  `DraftTarget`.
- **trtllm-serve's `/metrics` is a JSON queue emptied by each read.** Prometheus metrics are at
  `/prometheus/metrics`, and AIPerf's default scrape of `/metrics` has to be turned off.
- **dcgm-exporter 4.9 renamed its metrics** (`DCGM_FI_DEV_GPU_UTIL` is now
  `DCGM_FI_DEV_GPU_UTIL_RATIO`, 0 to 1). Dashboards written for older versions show nothing.
- TensorRT-LLM rejects request fields it does not declare (`extra="forbid"`), so a benchmark's extra
  inputs must be ones it knows. `ignore_eos` is.

## Open questions for the first GPU run

- Whether Qwen2.5-0.5B works as a draft for Qwen2.5-7B: NVIDIA has not tested the pair and the two
  declare different vocabulary sizes. The fallback, a model-free suffix automaton, is in the target file.
- Whether 4-bit AWQ calibration fits: it needs the BF16 model in memory. FP8 has a low-memory mode.
  If AWQ does not fit, it runs once on a rented 24 GB GPU with the same script.
- Whether the BF16 reference can be scored on 16 GB with a 2048-token context. Same fallback.
- Whether `--tool_parser qwen3` reads Qwen2.5's tool calls. The format matches; the conformance test decides.
- Whether vLLM loads the ModelOpt FP8 checkpoint. Both projects document it; it has not been tried here.
- `bench/summarize.py` was written from AIPerf's and lm-eval's documented output formats.
- The chart has not run on GPU nodes: the real engines' flags, GPU scheduling and the models volume
  are untested there.

## Not covered

Mixture-of-experts serving, tensor parallelism across GPUs or nodes, and Nsight Systems profiling:
none applies to one dense 7B model that fits on one GPU.

On Kubernetes, two things a larger deployment needs are left out. Autoscaling should follow queue
length (`num_requests_waiting`), not GPU utilisation, which sits near 100% whenever anything is
generating. Routing is load-aware but not cache-aware: a follow-up request can land on a replica
that does not hold the conversation's KV blocks. The Gateway API Inference Extension solves that at
the cluster level.
