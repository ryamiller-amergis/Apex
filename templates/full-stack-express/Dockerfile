# One production image for the API and the built web client.
# Build from this directory with pnpm container:build.
# Schema changes stay outside this image.

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate

FROM base AS build
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/check-toolchain.mjs ./scripts/check-toolchain.mjs
RUN corepack pnpm install --frozen-lockfile
COPY . .
RUN corepack pnpm build

FROM base AS prod-deps
WORKDIR /src
COPY --from=build /src /src
RUN corepack pnpm --filter @project-scope/api deploy --legacy --prod /out/api \
  && node scripts/supply-chain/check-runtime-graph.mjs /out/api \
  && rm -rf \
    /out/api/drizzle \
    /out/api/src \
    /out/api/test \
    /out/api/dist/cli \
    /out/api/dist/persistence/migrations \
    /out/api/dist/persistence/seed

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime

RUN rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
  && groupadd --system --gid 10001 app \
  && useradd --system --uid 10001 --gid 10001 --home-dir /app --shell /usr/sbin/nologin app

WORKDIR /app
COPY --from=prod-deps --chown=10001:10001 /out/api /app
COPY --from=build --chown=10001:10001 /src/apps/web/dist /app/web

ENV NODE_ENV=production
ENV CLIENT_DIST_DIR=/app/web

USER 10001
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||3000;fetch('http://127.0.0.1:'+port+'/health/live').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "--import", "./dist/instrument.js", "dist/index.js"]
