# load-test-k6 runner image (FEAT-008)

Ephemeral Azure Container Apps Job entrypoint that:

1. Receives a `LoadTestDispatchMessage` (Service Bus or `LT_DISPATCH_MESSAGE_JSON`)
2. Posts progress/heartbeat to Apex ingest
3. Asserts final allowlist / non-prod
4. Resolves Key Vault secret refs and injects them into the k6 process env
5. Executes the **persisted** script (execution source of truth)
6. Uploads metric-only summary/timeseries to `lt-artifacts`
7. Posts final / cancel_ack ingest (never writes Postgres directly — BR-008)

**Developer machine tools** (Chocolatey install for Docker, Node, k6, etc.) live in the root [`README.md`](../../README.md#windows-developer-tooling-chocolatey) — Prerequisites → Windows developer tooling.

## Build

From the repo root (after `npm run build:server`):

```bash
docker build -f runners/load-test-k6/Dockerfile -t apex-lt-k6:local .
```

Pin the resulting digest on the Container Apps Job (`var.lt_runner_image` in Terraform).

## Runtime env

| Variable | Purpose |
|----------|---------|
| `APEX_CALLBACK_URL` / message `callbackBaseUrl` | Apex base URL for ingest |
| `LT_RUNNER_CALLBACK_TOKEN` | Shared bearer for FEAT-007 runner auth (dev/non-MI) |
| `LT_CALLBACK_TOKEN_AUDIENCE` | Optional AAD audience when using MI JWT instead of static token |
| `LT_BLOB_ACCOUNT_NAME` | Storage account for artifacts |
| `LT_BLOB_CONTAINER_NAME` | Default `lt-artifacts` |
| `LT_SERVICEBUS_NAMESPACE` | Dedicated load-test namespace |
| `LT_QUEUE_NAME` | Default `lt-dispatch` |
| `AZURE_CLIENT_ID` | User-assigned runner MI client id |
| `LT_KEY_VAULT_URI` | Default vault when secret refs are bare names |
| `LT_DISPATCH_MESSAGE_JSON` | Local/dev injection of a dispatch payload (skips Service Bus) |
| `K6_PATH` | Optional path to k6 binary (default `k6`) |

## Local smoke (no Azure)

```bash
export LT_DISPATCH_MESSAGE_JSON='{"dispatchMessageId":"...","projectId":"...","runId":"...","definitionId":"...","targetUrl":"https://staging.example.com","environment":"staging","script":"export default function () {}","loadProfile":{"vus":1,"durationMinutes":1},"clientThresholds":[],"secretRefs":{},"callbackBaseUrl":"http://host.docker.internal:3000"}'
export LT_RUNNER_CALLBACK_TOKEN=dev-token
export APEX_CALLBACK_URL=http://host.docker.internal:3000
# Wire blob/KV mocks or skip by using unit tests for fail-closed paths
node dist/server/services/loadTestRunner/entrypoint.js
```

## Out of scope

- k6-Operator distributed runner (interface reserved via `LoadTestRunner`)
- Direct Postgres writes
- Host CPU/memory metrics
