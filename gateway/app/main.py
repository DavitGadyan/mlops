"""OpenAI-compatible gateway in front of the inference engines.

An engine is never exposed directly. This layer adds the API key, picks the
engine from the `model` field, and relays the stream without touching it.
"""

import asyncio
import secrets
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse, Response

from . import balancer
from .proxy import ApiError, forward
from .settings import Settings

# The three GPU numbers the UI shows next to the chat. Metric names are those of
# dcgm-exporter 4.9, which renamed the older DCGM_FI_DEV_GPU_UTIL family.
GPU_QUERIES = {
    "util_pct": "avg(DCGM_FI_DEV_GPU_UTIL_RATIO) * 100",
    "vram_used_gib": "sum(DCGM_FI_DEV_FB_USED_BYTES) / 2^30",
    "power_w": "sum(DCGM_FI_DEV_BOARD_POWER_WATTS)",
}


@lru_cache
def get_settings() -> Settings:
    return Settings()


Config = Annotated[Settings, Depends(get_settings)]


def require_key(settings: Config, authorization: Annotated[str, Header()] = "") -> None:
    expected = f"Bearer {settings.api_key}"
    if not secrets.compare_digest(authorization.encode(), expected.encode()):
        raise ApiError(401, "invalid_api_key", "Missing or wrong API key")


def resolve(settings: Settings, model: str) -> str:
    """`qwen7b` -> the default engine's URL, `vllm/qwen7b` -> that engine's URL."""
    engine, _, name = model.rpartition("/")
    engine = engine or settings.default_engine
    if name != settings.model_name or engine not in settings.engines:
        raise ApiError(404, "model_not_found", f"The model `{model}` does not exist")
    return settings.engines[engine]


async def engine_status(client: httpx.AsyncClient, settings: Settings) -> list[dict]:
    async def ready_replicas(url: str) -> int:
        """How many replicas the engine has, or 0 if it does not answer."""
        try:
            found = await balancer.replicas(url)
            answers = (await client.get(f"{found[0]}/health", timeout=1)).status_code == 200
            return len(found) if answers else 0
        except (OSError, httpx.TransportError):  # no DNS record, or nothing listening
            return 0

    counts = await asyncio.gather(*map(ready_replicas, settings.engines.values()))
    return [
        {
            "id": engine,
            "model": f"{engine}/{settings.model_name}",  # what a client sends to pick this engine
            "label": settings.engine_labels.get(engine, engine),
            "healthy": count > 0,
            "replicas": count,
            "default": engine == settings.default_engine,
        }
        for engine, count in zip(settings.engines, counts)
    ]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One pooled client for the whole process. The long read timeout covers a
    # request waiting in the engine's queue under load; connect stays short so
    # a dead engine fails fast.
    async with httpx.AsyncClient(timeout=httpx.Timeout(300, connect=5)) as client:
        app.state.client = client
        app.state.balancer = balancer.Balancer()
        yield


app = FastAPI(title="qwen7b gateway", lifespan=lifespan)
api = APIRouter(dependencies=[Depends(require_key)])


@app.exception_handler(ApiError)
async def render_error(_: Request, exc: ApiError) -> JSONResponse:
    kind = "invalid_request_error" if exc.status < 500 else "server_error"
    return JSONResponse({"error": {"message": exc.message, "type": kind, "code": exc.code}}, exc.status)


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@api.post("/v1/chat/completions")
async def chat_completions(request: Request, settings: Config):
    body = await request.json()
    base_url = resolve(settings, body.get("model", ""))
    body["model"] = settings.model_name  # engines only know the bare name
    state = request.app.state
    return await forward(state.client, state.balancer, base_url, "/v1/chat/completions", body)


@api.get("/v1/models")
async def models(request: Request, settings: Config) -> dict:
    live = [e for e in await engine_status(request.app.state.client, settings) if e["healthy"]]
    ids = [e["model"] for e in live]
    if any(e["default"] for e in live):
        ids.insert(0, settings.model_name)
    return {"object": "list", "data": [{"id": i, "object": "model", "owned_by": "local"} for i in ids]}


@api.get("/engines")
async def engines(request: Request, settings: Config) -> list[dict]:
    return await engine_status(request.app.state.client, settings)


@api.get("/results")
def results(settings: Config) -> Response:
    # Written by bench/summarize.py from real runs. Until it exists the UI shows
    # an empty state; the repo ships no placeholder numbers.
    if not settings.results_file.exists():
        raise ApiError(404, "no_results", "No results yet. Run `make bench eval summary`.")
    return Response(settings.results_file.read_bytes(), media_type="application/json")


@api.get("/gpu")
async def gpu(request: Request, settings: Config) -> dict:
    client: httpx.AsyncClient = request.app.state.client

    async def query(expr: str) -> float | None:
        reply = await client.get(f"{settings.prometheus_url}/api/v1/query", params={"query": expr}, timeout=2)
        series = reply.json()["data"]["result"]
        return float(series[0]["value"][1]) if series else None

    try:
        values = await asyncio.gather(*map(query, GPU_QUERIES.values()))
    except (httpx.TransportError, KeyError, ValueError) as exc:
        raise ApiError(503, "metrics_unavailable", f"Prometheus did not answer: {exc!r}") from exc
    return dict(zip(GPU_QUERIES, values))


app.include_router(api)
