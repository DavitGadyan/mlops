import threading
import time
from contextlib import contextmanager

import pytest
import uvicorn

from app.main import app, get_settings
from app.settings import Settings

from .fake_engine import create_app as fake_engine

KEY = {"authorization": "Bearer test-key"}


@contextmanager
def serve(asgi_app):
    """Run an app on a real socket.

    A client disconnect only exists on a real connection, so the cancellation
    test cannot use an in-process transport.
    """
    server = uvicorn.Server(uvicorn.Config(asgi_app, host="127.0.0.1", port=0, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join()


@pytest.fixture(scope="session")
def engines():
    """Two fake engines, so routing between them can be observed."""
    with serve(fake_engine(delay=0.05)) as trtllm, serve(fake_engine(delay=0.05)) as vllm:
        yield {"trtllm": trtllm, "vllm": vllm}


@pytest.fixture(scope="session")
def gateway(engines):
    settings = Settings(
        api_key="test-key",
        engines={**engines, "down": "http://127.0.0.1:1"},  # nothing listens on port 1
        default_engine="trtllm",
        results_file="/nonexistent/summary.json",
    )
    app.dependency_overrides[get_settings] = lambda: settings
    with serve(app) as url:
        yield url
