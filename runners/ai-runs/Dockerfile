# FEAT-004 — fenced Cursor background worker image
# Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs/Dockerfile -t apex-ai-runs:local .

FROM node:24-bookworm-slim

# The MaxView investigation Skill logs in with az. The slim image has no CLI,
# and installing it during a run needs tools this image does not ship.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl apt-transport-https gnupg \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the production dependencies used by the compiled worker graph.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

# Verify the compiled module graph without executing main().
RUN node -e "require('./dist/server/services/aiRunsWorker/entrypoint.js'); console.log('entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/aiRunsWorker/entrypoint.js"]
