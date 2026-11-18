"""Does an engine speak OpenAI chat completions the way clients expect?

Runs against a real engine, so it is skipped by default:

    ENGINE_URL=http://localhost:8001 uv run pytest -m live        (or `make conformance`)

Each test is one behaviour a client depends on. A failure is a finding about the
engine, to be fixed in its configuration or written down in the README.
"""

import json
import os
import re
import time

import httpx
import pytest

pytestmark = pytest.mark.live

URL = os.environ.get("ENGINE_URL", "")
WEATHER = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}


def chat(content: str, **params) -> dict:
    return {"model": "qwen7b", "messages": [{"role": "user", "content": content}], "temperature": 0, **params}


def stream(body: dict) -> list[str]:
    """The payload of every `data:` line of one streamed reply."""
    with httpx.stream(
        "POST", f"{URL}/v1/chat/completions", json={**body, "stream": True}, timeout=120
    ) as reply:
        assert reply.status_code == 200, reply.read()
        return [line[5:].strip() for line in reply.iter_lines() if line.startswith("data:")]


def test_stream_shape_and_usage_block():
    events = stream(chat("Say hello.", max_tokens=16, stream_options={"include_usage": True}))

    assert events[-1] == "[DONE]"
    chunks = [json.loads(event) for event in events[:-1]]
    assert all(chunk["object"] == "chat.completion.chunk" for chunk in chunks)
    assert chunks[0]["choices"][0]["delta"]["role"] == "assistant"
    # Usage comes last, in a chunk of its own with no choices.
    assert chunks[-1]["choices"] == []
    assert chunks[-1]["usage"]["completion_tokens"] > 0
    assert chunks[-1]["usage"]["prompt_tokens"] > 0


def test_no_usage_chunk_unless_asked():
    chunks = [json.loads(event) for event in stream(chat("Say hello.", max_tokens=16))[:-1]]
    assert all(chunk["choices"] for chunk in chunks)


def test_max_tokens_ends_with_finish_reason_length():
    reply = httpx.post(
        f"{URL}/v1/chat/completions", json=chat("Count from 1 to 500.", max_tokens=8), timeout=120
    )
    body = reply.json()
    assert body["choices"][0]["finish_reason"] == "length"
    assert body["usage"]["completion_tokens"] == 8


def test_tool_call_is_parsed_out_of_the_text():
    reply = httpx.post(
        f"{URL}/v1/chat/completions",
        json=chat("What is the weather in Yerevan right now?", tools=[WEATHER], max_tokens=128),
        timeout=120,
    )
    choice = reply.json()["choices"][0]
    # The model writes <tool_call>{...}</tool_call>; the engine's parser must turn
    # that into structured tool_calls instead of leaving it in the content.
    assert choice["finish_reason"] == "tool_calls"
    [call] = choice["message"]["tool_calls"]
    assert call["function"]["name"] == "get_weather"
    assert "city" in json.loads(call["function"]["arguments"])


def running_requests() -> float:
    """The engine's own count of requests in generation, from its Prometheus metrics."""
    for path in ("/prometheus/metrics", "/metrics"):  # TensorRT-LLM, then vLLM
        text = httpx.get(f"{URL}{path}").text
        values = re.findall(
            r"^(?:trtllm_|vllm:)num_requests_running(?:\{[^}]*\})? (\S+)$", text, re.MULTILINE
        )
        if values:
            return sum(map(float, values))
    pytest.fail("the engine exposes no num_requests_running metric")


def test_closing_the_connection_stops_generation():
    body = {**chat("Write a very long story.", max_tokens=2000), "stream": True}
    with httpx.stream("POST", f"{URL}/v1/chat/completions", json=body, timeout=120) as reply:
        lines = reply.iter_lines()
        for _ in range(5):
            next(lines)
        assert running_requests() >= 1
    # The client is gone. An engine that keeps generating wastes its batch slot
    # and KV cache on a reply nobody will read.
    deadline = time.monotonic() + 5
    while running_requests() > 0 and time.monotonic() < deadline:
        time.sleep(0.2)
    assert running_requests() == 0
