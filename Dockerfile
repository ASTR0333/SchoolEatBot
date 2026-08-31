FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /build
COPY pyproject.toml ./
COPY app ./app
RUN python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip \
    && /opt/venv/bin/pip install .

FROM python:3.12-slim

ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system bot \
    && adduser --system --ingroup bot --home /app bot

COPY --from=builder /opt/venv /opt/venv
WORKDIR /app
COPY --chown=bot:bot app ./app
RUN mkdir -p /app/data && chown bot:bot /app/data

USER bot
CMD ["python", "-m", "app.main"]
