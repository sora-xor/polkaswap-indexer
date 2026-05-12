FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock* .yarnrc.yml* ./
RUN corepack enable && yarn install --immutable || yarn install
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN yarn build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
STOPSIGNAL SIGTERM
COPY package.json yarn.lock* .yarnrc.yml* ./
RUN corepack enable && yarn install --immutable || yarn install
COPY --from=build /app/dist ./dist
EXPOSE 4350
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4350/graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'query { _health { ok } }'})}).then(async (response)=>{if(!response.ok) process.exit(1); const body=await response.json(); if(!body.data?._health?.ok) process.exit(1);}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
