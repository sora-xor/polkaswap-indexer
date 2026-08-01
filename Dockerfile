FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS dependencies
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --immutable

FROM dependencies AS build
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN yarn build

FROM dependencies AS production-dependencies
RUN yarn workspaces focus --all --production

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4350 \
    GRAPHQL_PATH=/graphql \
    GRAPHQL_HTTP_MAX_BODY_BYTES=65536 \
    HTTP_MAX_HEADER_BYTES=16384 \
    HTTP_MAX_CONNECTIONS=2048 \
    HTTP_MAX_REQUESTS_PER_SOCKET=1000 \
    RATE_LIMIT_WINDOW_MS=60000 \
    RATE_LIMIT_MAX=600 \
    RATE_LIMIT_MAX_KEYS=20000 \
    RATE_LIMIT_GLOBAL_WINDOW_MS=60000 \
    RATE_LIMIT_GLOBAL_MAX=50000 \
    GRAPHQL_MAX_DEPTH=12 \
    GRAPHQL_MAX_FIELDS=300 \
    GRAPHQL_MAX_ALIASES=50 \
    GRAPHQL_ALLOW_INTROSPECTION=false \
    GRAPHQL_WS_MAX_PAYLOAD_BYTES=65536 \
    GRAPHQL_WS_MAX_CONNECTIONS=512 \
    GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT=16 \
    GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION=32 \
    GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS=10000
STOPSIGNAL SIGTERM
RUN mkdir -p /data && chown node:node /data
COPY --from=production-dependencies --chown=node:node /app/package.json ./package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 4350
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS=4000 node dist/src/scripts/production-smoke.js "http://127.0.0.1:${PORT:-4350}${GRAPHQL_PATH:-/graphql}" >/dev/null 2>&1
CMD ["node", "dist/src/index.js"]
