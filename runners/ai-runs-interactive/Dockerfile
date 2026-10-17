# FEAT-007 — Dapr virtual-actor interactive AI-runs host image
# Long-running Azure Container App (not a one-shot Job). Dapr sidecar invokes
# the registered InteractiveSessionActor; the API dispatches turns via ingress.
# Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-interactive/Dockerfile -t apex-ai-runs-interactive:local .

FROM node:24-bookworm-slim

WORKDIR /app

# Grounded turns restore a repository checkout from a git bundle. CAB release
# turns run the MaxView PowerShell scripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://packages.microsoft.com/keys/microsoft.asc \
    | gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
    > /etc/apt/sources.list.d/microsoft-prod.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends powershell \
  && rm -rf /var/lib/apt/lists/*

COPY runners/cursor-pool-worker/git-credential.sh /usr/local/bin/git-credential-ado
RUN chmod 0555 /usr/local/bin/git-credential-ado \
  && git config --system credential.https://dev.azure.com.helper /usr/local/bin/git-credential-ado

# Install only the production dependencies used by the compiled host graph.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

# Verify the compiled module graph without executing main().
RUN node -e "require('./dist/server/services/interactiveActorHost/entrypoint.js'); console.log('interactive entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/interactiveActorHost/entrypoint.js"]
