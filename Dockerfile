FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian_trusted_root_ca.crt

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 101 bot \
    && useradd --system --uid 100 --gid bot --home-dir /app --shell /usr/sbin/nologin bot

COPY certs/russian_trusted_root_ca.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=bot:bot src ./src
RUN mkdir -p /app/data && chown bot:bot /app/data

USER bot
CMD ["node", "src/index.js"]
