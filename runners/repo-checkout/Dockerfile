# Admin repository checkout worker
# Build from repo root:
#   npm run build:server
#   docker build -f runners/repo-checkout/Dockerfile -t apex-repo-checkout:local .

FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/repoCheckoutWorker/entrypoint.js'); console.log('entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/repoCheckoutWorker/entrypoint.js"]
