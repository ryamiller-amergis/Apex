# FEAT-008 — k6 Container Apps Job runner image
# Build from repo root:
#   npm run build:server
#   docker build -f runners/load-test-k6/Dockerfile -t apex-lt-k6:local .

FROM grafana/k6:0.54.0 AS k6

FROM node:24-bookworm-slim

COPY --from=k6 /usr/bin/k6 /usr/bin/k6

WORKDIR /app

# Production deps needed by the compiled entrypoint
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled Apex server + shared types (includes loadTestRunner entrypoint)
COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

ENV NODE_ENV=production
ENV K6_PATH=/usr/bin/k6

# Container Apps Job executes one dispatch message then exits.
CMD ["node", "dist/server/services/loadTestRunner/entrypoint.js"]
