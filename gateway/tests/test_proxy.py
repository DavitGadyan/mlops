import time

import httpx

from .conftest import KEY

CHAT = {
    "model": "qwen7b",
    "messages": [{"role": "user", "content": "hi"}],
    "stream": True,
    "stream_options": {"include_usage": True},
}


def post(base_url: str, **changes) -> httpx.Response:
    return httpx.post(f"{base_url}/v1/chat/completions", json={**CHAT, **changes}, headers=KEY)


def started(engine_url: str) -> int:
    return httpx.get(f"{engine_url}/_stats").json()["started"]


def test_stream_is_relayed_byte_for_byte(gateway, engines):
    direct = post(engines["trtllm"])
    relayed = post(gateway)

    assert relayed.status_code == 200
    assert relayed.headers["content-type"] == direct.headers["content-type"]
    assert relayed.content == direct.content
    # The parts a re-encoding proxy tends to lose.
    assert b'"usage": {"prompt_tokens"' in relayed.content
    assert relayed.content.endswith(b"data: [DONE]\n\n")


def test_model_prefix_selects_the_engine(gateway, engines):
    before = started(engines["vllm"])
    assert post(gateway, model="vllm/qwen7b").status_code == 200
    assert started(engines["vllm"]) == before + 1


def test_requests_go_to_the_least_busy_replica(gateway, engines, monkeypatch):
    # Give the default engine two replicas, as a headless Service with two ready pods would.
    async def two_replicas(base_url: str) -> list[str]:
        return [engines["trtllm"], engines["vllm"]] if base_url == engines["trtllm"] else [base_url]

    monkeypatch.setattr("app.balancer.replicas", two_replicas)
    before = {name: started(url) for name, url in engines.items()}

    with httpx.stream("POST", f"{gateway}/v1/chat/completions", json=CHAT, headers=KEY) as busy:
        chunks = busy.iter_raw()  # kept in a variable: dropping the iterator would close the stream
        next(chunks)  # the first replica now has a request in flight...
        assert post(gateway).status_code == 200  # ...so this one must go to the other
        assert httpx.get(f"{gateway}/engines", headers=KEY).json()[0]["replicas"] == 2

    assert {name: started(url) - before[name] for name, url in engines.items()} == {"trtllm": 1, "vllm": 1}


def test_client_disconnect_cancels_generation(gateway, engines):
    stats_url = f"{engines['trtllm']}/_stats"
    before = httpx.get(stats_url).json()["cancelled"]

    with httpx.stream("POST", f"{gateway}/v1/chat/completions", json=CHAT, headers=KEY) as reply:
        chunks = reply.iter_raw()
        next(chunks)  # generation has started...
    # ...and leaving the block drops the connection, like pressing Stop.

    deadline = time.monotonic() + 2
    while httpx.get(stats_url).json()["cancelled"] == before and time.monotonic() < deadline:
        time.sleep(0.02)
    assert httpx.get(stats_url).json()["cancelled"] == before + 1


def test_missing_key_is_rejected(gateway):
    reply = httpx.post(f"{gateway}/v1/chat/completions", json=CHAT)
    assert reply.status_code == 401
    assert reply.json()["error"]["code"] == "invalid_api_key"


def test_unknown_model_is_404(gateway):
    for model in ("gpt-4", "nope/qwen7b", ""):
        reply = post(gateway, model=model)
        assert reply.status_code == 404, model
        assert reply.json()["error"]["code"] == "model_not_found"


def test_engine_down_is_503(gateway):
    reply = post(gateway, model="down/qwen7b")
    assert reply.status_code == 503
    assert reply.json()["error"]["code"] == "engine_unavailable"


def test_engine_list_reports_health(gateway):
    listed = {e["id"]: e for e in httpx.get(f"{gateway}/engines", headers=KEY).json()}
    assert listed["trtllm"] == {
        "id": "trtllm",
        "model": "trtllm/qwen7b",
        "label": "trtllm",
        "healthy": True,
        "replicas": 1,
        "default": True,
    }
    assert listed["vllm"]["healthy"] is True
    assert (listed["down"]["healthy"], listed["down"]["replicas"]) == (False, 0)

    models = [m["id"] for m in httpx.get(f"{gateway}/v1/models", headers=KEY).json()["data"]]
    assert models == ["qwen7b", "trtllm/qwen7b", "vllm/qwen7b"]


def test_results_are_404_until_a_real_run(gateway):
    reply = httpx.get(f"{gateway}/results", headers=KEY)
    assert reply.status_code == 404
    assert reply.json()["error"]["code"] == "no_results"
