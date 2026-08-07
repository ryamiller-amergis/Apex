# FEAT-007 — Dapr virtual-actor interactive AI-runs host image
# Long-running Azure Container App (not a one-shot Job). Dapr sidecar invokes
# the registered InteractiveSessionActor; the API dispatches turns via ingress.
# Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-interactive/Dockerfile -t apex-ai-runs-interactive:local .

FROM node:24-bookworm-slim

WORKDIR /app

# Install only the production dependencies used by the compiled host graph.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

# Verify the compiled module graph without executing main().
RUN node -e "require('./dist/server/services/interactiveActorHost/entrypoint.js'); console.log('interactive entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/interactiveActorHost/entrypoint.js"]
