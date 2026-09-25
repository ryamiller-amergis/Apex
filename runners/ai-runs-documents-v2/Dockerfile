# V2 document lane worker (Task 6).
# Separate from App Service and from the V1 ai-runs runner. Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-documents-v2/Dockerfile -t apex-ai-runs-documents-v2:local .

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/aiRunsV2Worker/documentEntrypoint.js'); console.log('ai-runs-documents-v2 entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/aiRunsV2Worker/documentEntrypoint.js"]
