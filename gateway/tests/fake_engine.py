"""A stand-in for trtllm-serve / vLLM: same wire format, canned text, no GPU.

Used by the gateway tests and by `make dev`, so the gateway and UI can be worked
on without a GPU. It says what it is in every reply.
"""

import asyncio
import json

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

REPLY = "This text comes from the fake engine, not from a model. Start a real engine to see real output."
TOOL_CALL = {
    "index": 0,
    "id": "call_fake",
    "type": "function",
    "function": {"name": "get_weather", "arguments": '{"city": "Yerevan"}'},
}


def create_app(delay: float = 0.03) -> FastAPI:
    app = FastAPI()
    app.state.stats = {"started": 0, "cancelled": 0}

    def event(choices: list, usage: dict | None = None) -> str:
        body = {
            "id": "chatcmpl-fake",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "qwen7b",
            "choices": choices,
            "usage": usage,
        }
        return f"data: {json.dumps(body)}\n\n"

    def choice(delta: dict, finish_reason: str | None = None) -> list:
        return [{"index": 0, "delta": delta, "finish_reason": finish_reason}]

    async def stream(body: dict):
        app.state.stats["started"] += 1
        words = REPLY.split(" ")
        try:
            yield event(choice({"role": "assistant", "content": ""}))
            if body.get("tools"):
                words = words[:1]  # the whole call arrives as one chunk
                await asyncio.sleep(delay)
                yield event(choice({"tool_calls": [TOOL_CALL]}))
                yield event(choice({}, "tool_calls"))
            else:
                for i, word in enumerate(words):
                    await asyncio.sleep(delay)
                    yield event(choice({"content": word if i == 0 else f" {word}"}))
                yield event(choice({}, "stop"))
            if body.get("stream_options", {}).get("include_usage"):
                yield event(
                    [],
                    {"prompt_tokens": 12, "completion_tokens": len(words), "total_tokens": 12 + len(words)},
                )
            yield "data: [DONE]\n\n"
        except asyncio.CancelledError:
            app.state.stats["cancelled"] += 1  # the client went away mid-generation
            raise

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request):
        return StreamingResponse(stream(await request.json()), media_type="text/event-stream")

    @app.get("/health")
    def health() -> dict:
        return {}

    @app.get("/_stats")
    def stats() -> dict:
        return app.state.stats

    return app
