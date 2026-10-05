# Stage 3 — repo-read service image
# Serves git cat-file / ls-tree / grep from a bare mirror on ephemeral disk.
# Build from repo root:
#   npm run build:server
#   docker build -f runners/repo-read-service/Dockerfile -t apex-repo-read:local .

FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/repoRead/entrypoint.js'); console.log('repo-read entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/repoRead/entrypoint.js"]
