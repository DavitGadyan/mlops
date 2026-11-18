import anyio
import httpx
from starlette.responses import StreamingResponse

from .balancer import Balancer


class ApiError(Exception):
    """Rendered in OpenAI's error shape so OpenAI SDK clients raise their usual exceptions."""

    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


async def forward(
    client: httpx.AsyncClient, balancer: Balancer, base_url: str, path: str, body: dict
) -> StreamingResponse:
    """Send one request to an engine replica and relay the reply byte for byte.

    The reply is never parsed. Chat-completions conformance (chunk shape, usage
    block, `[DONE]`) is the engine's job, and a gateway that re-encodes the stream
    can only break it.
    """
    try:
        replica = await balancer.acquire(base_url)
    except OSError as exc:  # the engine's name has no address: no replica is ready
        raise ApiError(503, "engine_unavailable", f"Engine has no ready replica: {exc!r}") from exc

    # identity: we relay raw bytes, so the engine must not compress them.
    request = client.build_request("POST", replica + path, json=body, headers={"accept-encoding": "identity"})
    try:
        upstream = await client.send(request, stream=True)
    except httpx.TransportError as exc:
        balancer.release(replica)
        raise ApiError(503, "engine_unavailable", f"Engine did not answer: {exc!r}") from exc

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            # Reached on a normal finish and when the client goes away (Stop button,
            # closed tab, timeout). Closing the upstream connection is what tells the
            # engine to abort generation and free the batch slot and its KV cache.
            # Shielded because we are already being cancelled at this point.
            balancer.release(replica)
            with anyio.CancelScope(shield=True):
                await upstream.aclose()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
