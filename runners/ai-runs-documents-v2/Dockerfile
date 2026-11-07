# V2 document lane worker (Task 6).
# Separate from App Service and from the V1 ai-runs runner. Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-documents-v2/Dockerfile -t apex-ai-runs-documents-v2:local .

FROM node:24-bookworm-slim

# The MaxView investigation Skill logs in with az. The slim image has no CLI,
# and installing it during a run needs tools this image does not ship.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl apt-transport-https gnupg \
  && curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/aiRunsV2Worker/documentEntrypoint.js'); console.log('ai-runs-documents-v2 entrypoint module ok')"

ENV NODE_ENV=production

CMD ["node", "dist/server/services/aiRunsV2Worker/documentEntrypoint.js"]
