# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS build
WORKDIR /app
# better-sqlite3 compiles a native addon; unused in Phase 1 but proven here so
# Phase 4 does not discover a broken build stage.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Trixie (glibc 2.41), not bookworm (2.36): better-sqlite3's prebuilt aarch64
# addon imports fmod@GLIBC_2.38, so on bookworm the arm64 image died at startup
# while amd64 — needing only 2.34 — ran fine. test/dockerGlibc.test.ts fails if
# a future prebuild outgrows this base.
FROM node:24-trixie-slim AS runtime
WORKDIR /app

ARG ARR_MCP_VERSION=0.0.0-dev

# The node image already ships a non-root `node` user at 1000:1000, which is
# also our default PUID/PGID — reuse it rather than creating a second account
# at the same ids (groupadd -g 1000 fails outright).
RUN apt-get update && apt-get install -y --no-install-recommends gosu wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    ARR_MCP_CONFIG_DIR=/config \
    ARR_MCP_PORT=6060 \
    ARR_MCP_VERSION=$ARR_MCP_VERSION \
    PUID=1000 \
    PGID=1000

VOLUME ["/config"]
EXPOSE 6060

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:6060/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
# tsc emits under dist/src because rootDir is the repo root.
CMD ["node", "dist/src/index.js"]
