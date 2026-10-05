# Repo-read service — deployment runbook (Stage 3)

Turns on the repo-read Container App from `design-docs/repo-grounding-consolidation.md`
Stage 3. Everything in code and Terraform already exists; this switches it on.

## Why this unblocks the Container App lanes

Interactive turns currently bypass the Dapr actor lane on every request with
`reason=bare-mirror-no-checkout`. The guard is in `chatAgentService`:

```ts
if (!grounding.workingTree && !workerCanReadWithoutWorkingTree()) {
  return bypass('bare-mirror-no-checkout');
}
```

`workerCanReadWithoutWorkingTree()` is false until `REPO_READ_SERVICE_URL` is
set, because a Container App cannot read the App Service disk holding the bare
mirror. Setting it is what lets the WebSocket/actor lane run at all.

It should also cut search latency. The App Service mirror lives on
`/home/data`, an Azure Files SMB mount, and `git grep` over SMB is what forced
the 30s search budget. The service runs git on `/tmp` local SSD instead.

## Prerequisites

| Item | Value / where to find it |
|---|---|
| ACR name | GitHub Actions variable `AI_RUNS_ACR_NAME` |
| Container App name | `ca-apex-repo-read-dev` (Terraform default for `environment = dev`) |
| Resource group | `rg-scrum-dev` |
| App Service | `app-scrum-dev` |
| Callback token | Terraform `ai_runs_runner_callback_token` — must match the app setting below |

Docker and the Azure CLI are required locally only if you publish the image by
hand instead of letting CI do it.

## 1. Publish the image

CI now builds it automatically whenever `runners/repo-read-service/`,
`src/server/services/repoRead/`, or the publish script changes. Set the
GitHub Actions variable first, or the step skips itself:

```
REPO_READ_SERVICE_CONTAINER_APP_NAME = ca-apex-repo-read-dev
```

To publish by hand instead:

```bash
npm run build:server
AI_RUNS_ACR_NAME=<acr> \
REPO_READ_SERVICE_CONTAINER_APP_NAME=ca-apex-repo-read-dev \
AI_RUNS_RESOURCE_GROUP=rg-scrum-dev \
IMAGE_TAG=$(git rev-parse HEAD) \
bash scripts/ci/publish-repo-read-service.sh
```

The script pushes the image and then skips the Container App roll cleanly if
Terraform has not created the app yet, so it is safe to run before step 2.

## 2. Apply Terraform

No workflow runs Terraform — this is a manual apply.

```bash
cd infra
terraform plan \
  -var 'enable_repo_read_service=true' \
  -var 'repo_read_service_image=<acr>.azurecr.io/apex-repo-read:<sha>' \
  -out repo-read.tfplan
terraform apply repo-read.tfplan
```

Expect one Container App plus one `Storage Blob Data Contributor` role
assignment on the `repo-grounding` container. Terraform ignores image drift
afterwards, so CI owns the tag from then on.

Capture the FQDN:

```bash
terraform output -raw repo_read_service_app_fqdn
```

## 3. Set the App Service settings

```bash
az webapp config appsettings set \
  --name app-scrum-dev \
  --resource-group rg-scrum-dev \
  --settings \
    REPO_READ_SERVICE_URL="https://<fqdn-from-step-2>" \
    REPO_READ_SERVICE_TOKEN="<same value as ai_runs_runner_callback_token>"
```

A token mismatch fails every read closed — the endpoints sit behind
`requireAiRunnerAuth`. This restarts the app.

## 4. Enable the feature flag

Platform Admin → Feature Flags → `repo-read-service`, scoped to MaxView. The
migration already seeded it.

The flag gates bundle publishing as well as reads, so nothing is published
until it is on.

## 5. Expected first-run behaviour

No bundle exists for MaxView yet, and that is fine:

1. First grounding after the flag flips publishes the bundle in the background
   (fire-and-forget; `git bundle create` takes minutes on MaxView).
2. A cold container starting before that lands clones the remote once instead.
3. Later cold starts restore the bundle from Blob, which is the fast path.

No backfill script is needed.

## Verification

```bash
curl -s https://<fqdn>/healthz          # {"ok":true}
```

Then send a MaxView chat turn and confirm the bypass is gone:

```kusto
customEvents
| where timestamp > ago(15m) and name == "interactive.dispatch.bypass"
| extend r = tostring(customDimensions.reason)
| summarize count() by r
```

`bare-mirror-no-checkout` should stop appearing. Search latency by operation:

```kusto
customMetrics
| where timestamp > ago(1h) and name == "grounding.read.latency"
| extend op = tostring(customDimensions.operation)
| summarize avg(value), max(value) by op
```

If `searchCode` drops well under the 30s budget, the SMB theory is confirmed
and that budget can be tightened.

## Rollback

Unset `REPO_READ_SERVICE_URL` on the App Service. Reads fall back to the
in-process bare mirror and the interactive lane returns to bypassing — the
behaviour we have today. Turning the flag off stops bundle publishing. The
Container App can be left running; it costs one replica.
