# soc-migrate (FR-DEP-02): applies database/migrations, then exits. Built from
# the repository root,
#   docker build -f infra/migrate/Dockerfile .

FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.23@sha256:61d393e44e249f2e4b526b6c7ddcecce245946826e608e11c93ad4f5bba55b21 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY database/pyproject.toml database/
COPY libs libs
COPY services/soc-cloud/pyproject.toml services/soc-cloud/
COPY services/soc-operations/pyproject.toml services/soc-operations/
COPY infra/migrate infra/migrate
COPY database/migrations database/migrations
RUN uv sync --frozen --no-dev --package soc-migrate \
 && python -m compileall -q infra/migrate/src

FROM python:3.14.8-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin soc
COPY --from=build /app /app
ENV PATH=/app/.venv/bin:$PATH PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
USER 10001
ENTRYPOINT ["soc-migrate", "--directory", "/app/database/migrations"]
