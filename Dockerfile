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
COPY package.json yarn.lock* .yarnrc.yml* ./
RUN corepack enable && yarn install --immutable || yarn install
COPY --from=build /app/dist ./dist
EXPOSE 4350
CMD ["node", "dist/src/index.js"]
