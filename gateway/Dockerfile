FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /srv
# Dependencies first, so editing the app does not reinstall them.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-cache
COPY app app

USER nobody
EXPOSE 8080
CMD [".venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
