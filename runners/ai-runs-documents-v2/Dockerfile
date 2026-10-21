# V2 document lane worker (Task 6).
# Separate from App Service and from the V1 ai-runs runner. Build from repo root:
#   npm run build:server
#   docker build -f runners/ai-runs-documents-v2/Dockerfile -t apex-ai-runs-documents-v2:local .

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Promptfoo has its own pinned install so its packages stay out of the app's.
# Optional packages are agent SDKs the runner never loads (about 1.2 GB).
COPY runners/ai-runs-documents-v2/promptfoo/package.json runners/ai-runs-documents-v2/promptfoo/package-lock.json ./promptfoo/
RUN npm ci --prefix ./promptfoo --omit=dev --omit=optional --ignore-scripts
COPY runners/ai-runs-documents-v2/promptfoo/run.cjs ./promptfoo/run.cjs

COPY dist/server ./dist/server
COPY dist/shared ./dist/shared

RUN node -e "require('./dist/server/services/aiRunsV2Worker/documentEntrypoint.js'); console.log('ai-runs-documents-v2 entrypoint module ok')"
RUN node -e "console.log('promptfoo ' + require('/app/promptfoo/node_modules/promptfoo/package.json').version + ' installed')"

ENV NODE_ENV=production
ENV AI_RUNS_V2_PROMPTFOO_RUNNER=/app/promptfoo/run.cjs

CMD ["node", "dist/server/services/aiRunsV2Worker/documentEntrypoint.js"]
