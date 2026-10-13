# soc-operations (ADR-0017): built from the repository root,
#   docker build -f services/soc-operations/Dockerfile .

FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY database/pyproject.toml database/
COPY infra/migrate/pyproject.toml infra/migrate/
COPY services/soc-cloud/pyproject.toml services/soc-cloud/
COPY libs libs
COPY contracts/config contracts/config
COPY contracts/results contracts/results
COPY services/soc-operations services/soc-operations
RUN uv sync --frozen --no-dev --package soc-operations \
 && python -m compileall -q libs services/soc-operations/src

FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin soc
COPY --from=build /app /app
ENV PATH=/app/.venv/bin:$PATH MALLOC_ARENA_MAX=2 PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 SOC_HEALTH_PORT=8080
USER 10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/$SOC_HEALTH_PORT && printf 'GET /health HTTP/1.0\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q ' 200 '"]
ENTRYPOINT ["soc-operations"]
