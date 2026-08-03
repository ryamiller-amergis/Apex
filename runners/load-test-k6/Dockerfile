# FEAT-008 — k6 Container Apps Job runner image
# Build from repo root:
#   npm run build:server
#   docker build -f runners/load-test-k6/Dockerfile -t apex-lt-k6:local .

FROM grafana/k6:0.54.0 AS k6

FROM node:24-bookworm-slim

COPY --from=k6 /usr/bin/k6 /usr/bin/k6
# k6 official image is Alpine but built with CGO_ENABLED=0 (static) — verify it runs on Debian.
RUN k6 version

WORKDIR /app

# Production deps needed by the compiled entrypoint.
# --ignore-scripts: package.json postinstall patches esbuild for Windows AppLocker
# only (scripts/patch-esbuild-wasm.js); not needed in this Linux runner image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled Apex server + shared types (includes loadTestRunner entrypoint)
COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

# Fail the build if the entrypoint module graph cannot resolve (missing dist/deps).
# require.main !== module here, so main() does not execute.
RUN node -e "require('./dist/server/services/loadTestRunner/entrypoint.js'); console.log('entrypoint module ok')"

ENV NODE_ENV=production
ENV K6_PATH=/usr/bin/k6

# Container Apps Job executes one dispatch message then exits.
CMD ["node", "dist/server/services/loadTestRunner/entrypoint.js"]
