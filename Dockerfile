FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN corepack enable
RUN yarn install --immutable


FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN yarn build


FROM dependencies AS production-dependencies

# Yarn doesn't apply NODE_ENV to installs. Focus explicitly removes the build
# and test-only dependency graph while retaining native production packages.
RUN yarn workspaces focus --all --production


FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV ROCKSDB_PATH=/data/polkaswap-indexer.rocksdb

STOPSIGNAL SIGTERM

RUN install -d -o node -g node /data

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node LICENSE ./LICENSE

USER node

EXPOSE 4350

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "const port=Number(process.env.PORT??'4350');const path=process.env.GRAPHQL_PATH??'/graphql';if(!Number.isInteger(port)||port<1||port>65535||!path.startsWith('/')||/[\\s?#]/.test(path))process.exit(1);fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query { _health { ok } }'})}).then(async response=>{if(!response.ok)throw new Error('unhealthy');const body=await response.json();if(body?.data?._health?.ok!==true)throw new Error('not ready')}).then(()=>process.exit(0)).catch(()=>process.exit(1))"]

CMD ["node", "dist/src/index.js"]
