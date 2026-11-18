from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Read from environment variables; see .env.example for every value."""

    api_key: str
    # Engine id -> base URL, e.g. {"trtllm": "http://trtllm:8000", "vllm": "http://vllm:8000"}.
    engines: dict[str, str]
    # The engine switch: where a request for plain `model_name` is sent.
    default_engine: str
    # Shown in the UI, e.g. {"trtllm": "TensorRT-LLM · FP8"}.
    engine_labels: dict[str, str] = {}
    # Every engine serves the model under this one name, so clients never care which is live.
    model_name: str = "qwen7b"
    prometheus_url: str = "http://prometheus:9090"
    results_file: Path = Path("results/summary.json")
