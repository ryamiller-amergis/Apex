# V2 visual lane worker (Task 6).
# Separate from App Service and from the V1 ai-runs runner. Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-visual/Dockerfile -t apex-ai-runs-visual:local .

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/aiRunsV2Worker/visualEntrypoint.js'); console.log('ai-runs-visual entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/aiRunsV2Worker/visualEntrypoint.js"]
