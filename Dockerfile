FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS dependencies

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable && yarn install --immutable


FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN yarn build


FROM dependencies AS production-dependencies

# Yarn doesn't apply NODE_ENV to installs. Focus explicitly removes the build
# and test-only dependency graph while retaining native production packages.
RUN yarn workspaces focus --all --production


FROM node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4350 \
    GRAPHQL_PATH=/graphql \
    HTTP_MAX_HEADER_BYTES=16384 \
    HTTP_MAX_CONNECTIONS=2048 \
    HTTP_MAX_REQUESTS_PER_SOCKET=1000 \
    RATE_LIMIT_WINDOW_MS=60000 \
    RATE_LIMIT_MAX=600 \
    RATE_LIMIT_MAX_KEYS=20000 \
    RATE_LIMIT_GLOBAL_WINDOW_MS=60000 \
    RATE_LIMIT_GLOBAL_MAX=50000 \
    GRAPHQL_HTTP_MAX_BODY_BYTES=65536 \
    GRAPHQL_HTTP_MAX_IN_FLIGHT=100 \
    GRAPHQL_MAX_DEPTH=12 \
    GRAPHQL_MAX_DOCUMENT_NODES=2000 \
    GRAPHQL_MAX_FIELDS=300 \
    GRAPHQL_MAX_ALIASES=50 \
    GRAPHQL_MAX_FRAGMENT_SPREADS=100 \
    GRAPHQL_MAX_OPERATION_COST=100000 \
    GRAPHQL_ALLOW_INTROSPECTION=false \
    GRAPHQL_WS_MAX_PAYLOAD_BYTES=65536 \
    GRAPHQL_WS_CONNECTION_INIT_TIMEOUT_MS=10000 \
    GRAPHQL_WS_MAX_CONNECTIONS=512 \
    GRAPHQL_WS_MAX_CONNECTIONS_PER_CLIENT=16 \
    GRAPHQL_WS_MAX_OPERATIONS=1024 \
    GRAPHQL_WS_MAX_OPERATIONS_PER_CONNECTION=32 \
    GRAPHQL_WS_MAX_PENDING_MESSAGES_PER_CONNECTION=64 \
    MOBILE_CONFIG_NEXUS_AVAILABLE=true \
    MOBILE_CONFIG_NEXUS_SENDS_AVAILABLE=false \
    MOBILE_CONFIG_POLKAMARKT_VISIBLE=true \
    MOBILE_CONFIG_POLKAMARKT_MUTATIONS_AVAILABLE=false \
    MOBILE_CONFIG_TAIRA_DEFAULT_VISIBLE=true \
    ROCKSDB_PATH=/data/polkaswap-indexer.rocksdb

STOPSIGNAL SIGTERM
ENTRYPOINT ["docker-entrypoint.sh"]

# Runtime commands use compiled JavaScript. Do not ship package managers and
# their separate dependency trees or privilege-elevating mode bits.
RUN install -d -o node -g node /data \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && find /usr -xdev -type f -perm /6000 -exec chmod a-s '{}' +

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/src/runtime/LICENSE /app/src/runtime/README.md /app/src/runtime/provenance.json ./dist/src/runtime/
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node LICENSE ./LICENSE

USER node

EXPOSE 4350

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD POLKASWAP_INDEXER_SMOKE_TIMEOUT_MS=4000 node dist/src/scripts/production-smoke.js "http://127.0.0.1:${PORT:-4350}${GRAPHQL_PATH:-/graphql}" >/dev/null 2>&1

CMD ["node", "dist/src/index.js"]
