# V2 AI orchestrator — long-running Container App (Task 5).
# Separate from App Service. Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-orchestrator/Dockerfile -t apex-ai-orchestrator:local .

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/aiOrchestrator/entrypoint.js'); console.log('ai-orchestrator entrypoint module ok')"

ENV NODE_ENV=production
ENV AI_ORCHESTRATOR_ENABLED=true

CMD ["node", "dist/server/services/aiOrchestrator/entrypoint.js"]
