# Local interactive actor host.
# The Dapr CLI is blocked by machine policy, so this starts the same runtime
# pieces in Docker: Redis, placement, and the sidecar. The actor process stays
# on the host so it can read the local grounding checkout.
$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repoRoot

node (Join-Path $PSScriptRoot 'configure-local.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Local interactive actor configuration failed' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker Desktop is required. Install and start Docker Desktop, then run this script again.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker Desktop is not running. Start it and wait until docker info succeeds.'
}

docker network inspect apex-dapr 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  docker network create apex-dapr | Out-Null
}

$running = docker ps --format '{{.Names}}'
if ($running -notcontains 'apex-dapr-redis') {
  docker rm -f apex-dapr-redis 2>$null | Out-Null
  docker run -d --name apex-dapr-redis --network apex-dapr -p 6379:6379 redis:7-alpine | Out-Null
}
if ($running -notcontains 'apex-dapr-placement') {
  docker rm -f apex-dapr-placement 2>$null | Out-Null
  docker run -d --name apex-dapr-placement --network apex-dapr --entrypoint ./placement daprio/dapr:1.16.2 --port 50005 --listen-address 0.0.0.0 | Out-Null
}
if ($running -notcontains 'apex-dapr-sidecar') {
  docker rm -f apex-dapr-sidecar 2>$null | Out-Null
  docker run -d --name apex-dapr-sidecar --network apex-dapr -p 3500:3500 -p 50001:50001 `
    -v "${PSScriptRoot}\local-dapr:/components:ro" `
    daprio/daprd:1.16.2 ./daprd `
    --app-id apex-ai-interactive `
    --app-channel-address host.docker.internal `
    --app-port 8080 `
    --app-protocol http `
    --dapr-http-port 3500 `
    --dapr-grpc-port 50001 `
    --dapr-listen-addresses 0.0.0.0 `
    --placement-host-address apex-dapr-placement:50005 `
    --resources-path /components `
    --enable-metrics=false | Out-Null
}

$env:APEX_CALLBACK_URL = 'http://127.0.0.1:3001'
$env:AI_RUNS_INTERACTIVE_TARGET_PORT = '8080'
$env:PORT = '8080'
$env:DAPR_HTTP_PORT = '3500'
$env:DAPR_GRPC_PORT = '50001'
$env:AI_RUNS_INTERACTIVE_AGENT_RETRIES = 'false'
$env:AI_RUNS_INTERACTIVE_SDK_STORE_DIR = Join-Path $repoRoot 'data\cursor-sdk-interactive'

npx ts-node -P tsconfig.server.json -r dotenv/config src/server/services/interactiveActorHost/entrypoint.ts
