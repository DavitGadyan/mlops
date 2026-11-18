# One entry point for everything. `make` on its own lists the targets.

# A target is a file in engines/, named <engine>-<variant>. The engine part is
# its compose profile and decides its host port.
ENGINE ?= trtllm-fp8
KIND    = $(firstword $(subst -, ,$(ENGINE)))
URL     = http://localhost:$(if $(filter vllm,$(KIND)),8002,8001)

# The workload and the SLO goodput is counted against. Exported so the benchmark
# scripts and the summary agree on them.
export ISL         ?= 512
export OSL         ?= 256
export SLO_TTFT_MS ?= 500
export SLO_ITL_MS  ?= 50

# Paths set in .env also reach the benchmark scripts.
-include .env
export HF_CACHE MODELS_DIR

STACK   = docker compose --env-file .env --profile trtllm --profile vllm
COMPOSE = FIRST_ENGINE=$(KIND) docker compose --env-file .env --env-file engines/$(ENGINE).env --profile $(KIND)

# Ports for `make dev`, away from the usual 3000 and 8080.
DEV_UI      ?= 3411
DEV_GATEWAY ?= 8180
DEV_ENGINE  ?= 8101
# Real results once they exist. For UI work without them:
#   make dev RESULTS_FILE=tests/fixtures/summary.json
RESULTS_FILE ?= ../results/summary.json

.DEFAULT_GOAL := help
.PHONY: help up down logs quantize conformance bench eval spec-sweep summary test chart dev dev-engine dev-gateway dev-ui

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

## On the GPU host

up: ## Start the stack with one engine: make up ENGINE=vllm-awq
	$(STACK) rm --stop --force trtllm vllm  # one checkpoint fits in 16 GB at a time
	$(COMPOSE) up --detach --build --wait

down: ## Stop everything
	$(STACK) down

logs: ## Follow the engine's log
	$(COMPOSE) logs --follow $(KIND)

quantize: ## Quantize the model with ModelOpt: make quantize QFORMAT=fp8
	$(STACK) rm --stop --force trtllm vllm
	$(STACK) run --rm --entrypoint bash trtllm /config/quantize.sh $(or $(QFORMAT),fp8)

conformance: ## Check the running engine's OpenAI behaviour
	cd gateway && ENGINE_URL=$(URL) uv run pytest -m live -v

bench: ## AIPerf: closed-loop concurrency sweep, then one open-loop run
	bench/run.sh $(ENGINE) $(URL)

eval: ## lm-eval: gsm8k accuracy of the running engine
	bench/eval.sh $(ENGINE) $(URL)

spec-sweep: ## Speculative decoding: draft length x concurrency (restarts the engine)
	bench/spec_sweep.sh

summary: ## Collect raw results into results/summary.json for the UI
	uv run --no-project --python 3.12 bench/summarize.py

## Anywhere

test: ## Everything that runs without a GPU
	cd gateway && uv run pytest -q
	uv run --no-project --python 3.12 --with pytest pytest -q bench
	cd ui && pnpm install --frozen-lockfile && pnpm exec tsc --noEmit && pnpm lint

chart: ## Lint the Helm chart and check what it renders against the Kubernetes schemas
	helm lint chart --set apiKey=x --set images.gateway=x --set images.ui=x
	helm template qwen7b chart --set apiKey=x --set images.gateway=x --set images.ui=x \
		--set engines.vllm.enabled=true --set podMonitor.enabled=true \
		--set ingress.enabled=true --set ingress.host=qwen7b.test \
		| kubeconform -strict -summary -ignore-missing-schemas

dev: ## Gateway and UI against a fake engine, no GPU or Docker needed
	$(MAKE) -j3 dev-engine dev-gateway dev-ui

dev-engine:
	cd gateway && uv run uvicorn tests.fake_engine:create_app --factory --port $(DEV_ENGINE) --log-level warning

# vLLM is listed but nothing listens on its port, to show an engine that is down.
dev-gateway:
	cd gateway && API_KEY=dev DEFAULT_ENGINE=trtllm RESULTS_FILE=$(RESULTS_FILE) \
		ENGINES='{"trtllm": "http://127.0.0.1:$(DEV_ENGINE)", "vllm": "http://127.0.0.1:1"}' \
		ENGINE_LABELS='{"trtllm": "Fake engine (no GPU)", "vllm": "vLLM"}' \
		PROMETHEUS_URL=http://localhost:1 \
		uv run uvicorn app.main:app --port $(DEV_GATEWAY) --log-level warning

dev-ui:
	cd ui && pnpm install --frozen-lockfile && \
		GATEWAY_URL=http://localhost:$(DEV_GATEWAY) GATEWAY_API_KEY=dev pnpm exec next dev --port $(DEV_UI)
