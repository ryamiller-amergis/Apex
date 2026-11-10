# Build from Prompt Phase 2 — Milestone 0 Record

Date: 2026-11-05  
Baseline commit: `00ba4d48`  
Evidence captured: `2026-11-05T21:14:55-05:00`  
Status: Complete  
Scope: Measurements and architecture decisions only

## Outcome

Milestone 0 establishes a reproducible red baseline and prepares the pilot architecture decisions needed to begin the local full-stack walking skeleton.

The baseline is intentionally not described as healthy:

- No local Phase 1 deployment observation exists from which to calculate a static-preview success rate or deployment percentile.
- The isolated Golden Stack build passes.
- The isolated Golden Stack `check` and `test` commands fail before Phase 2 changes.
- The focused Phase 1 static-preview contract tests pass.
- Azure custom Dynamic Sessions is rejected as the direct browser runtime.
- Azure Container Apps Sandboxes is the preferred isolated pilot, not an approved production provider.

## Measurement Environment

- Operating system: Microsoft Windows 11 Enterprise `10.0.26100`
- CPU: AMD Ryzen 5 7535U, 6 cores / 12 logical processors
- Memory: 30.78 GiB
- Node: `v24.18.1`
- Template package manager: pnpm `10.34.9`
- Template: `templates/full-stack-express`
- Git source: detached clean worktree at `00ba4d48`
- Fresh-workspace install: no worktree `node_modules`; the machine-level pnpm store and network cache were not cleared
- Warm measurement: immediate second execution in the same worktree
- Measurements are wall-clock elapsed time on one developer workstation, not CI SLO evidence

## Phase 1 Static Preview Baseline

### Observed deployment data

The local PostgreSQL `build_revisions` table contains:

- 16 revisions with `deployment_status = 'not_started'`
- 0 revisions with a preview URL
- 0 deployment timing observations
- 0 deployment events

Therefore:

- Static-preview success rate: not measurable (`n = 0` attempted deployments)
- Queue-to-preview P50/P95: not measurable
- Production reliability claim: unavailable

Do not report this as a 0% success rate. There were no eligible attempts.

Captured result:

```text
deployment_status=not_started
revision_count=16
with_preview_url=0
avg_queue_to_deployed_seconds=null
p50_queue_to_deployed_seconds=null
p95_queue_to_deployed_seconds=null
deployment_event_count=0
```

Reproduction query:

```sql
SELECT
  deployment_status,
  COUNT(*) AS revision_count,
  COUNT(*) FILTER (WHERE preview_url IS NOT NULL) AS with_preview_url,
  AVG(EXTRACT(EPOCH FROM (deployed_at - deployment_queued_at)))
    FILTER (WHERE deployed_at IS NOT NULL AND deployment_queued_at IS NOT NULL)
    AS avg_queue_to_deployed_seconds,
  PERCENTILE_CONT(0.5) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (deployed_at - deployment_queued_at))
  ) FILTER (WHERE deployed_at IS NOT NULL AND deployment_queued_at IS NOT NULL)
    AS p50_queue_to_deployed_seconds,
  PERCENTILE_CONT(0.95) WITHIN GROUP (
    ORDER BY EXTRACT(EPOCH FROM (deployed_at - deployment_queued_at))
  ) FILTER (WHERE deployed_at IS NOT NULL AND deployment_queued_at IS NOT NULL)
    AS p95_queue_to_deployed_seconds
FROM build_revisions
GROUP BY deployment_status
ORDER BY deployment_status;

SELECT COUNT(*)::int AS deployment_event_count
FROM build_events
WHERE event_type LIKE 'deployment_%'
   OR event_type LIKE 'build_deployment_%';
```

### Static sample bundle

Command:

```powershell
# Working directory: templates/full-stack-express
$env:VITE_APEX_PREVIEW_MODE = 'sample'
corepack pnpm --filter @project-scope/web run build
```

Result:

- Wall time: 31.893 seconds
- Exit: 0
- Vite transform/build portion: 2.24 seconds
- Modules transformed: 797
- Main JavaScript chunk: 570.07 kB, 177.02 kB gzip
- Vite emitted a chunk-size warning above 500 kB

### Static-preview contract tests

Command:

```powershell
# Working directory: repository root
npm test -- --runInBand `
  src/server/__tests__/buildPreviewArtifactService.test.ts `
  src/server/__tests__/buildRunDeploymentProjection.test.ts `
  src/server/__tests__/buildDeploymentService.test.ts
```

Result:

- Wall time: 71.204 seconds
- Exit: 0
- Suites: 3 passed
- Tests: 8 passed
- Jest emitted pre-existing duplicate-manual-mock warnings from repository data/workspace folders

These tests prove the current bundle, settlement, and projection contracts. They do not prove a browser can load a deployed preview.

## Golden Stack Baseline

The harness was started from the repository root. It created a detached worktree at the recorded commit, changed to `templates/full-stack-express`, timed each command, and removed the worktree:

```powershell
$repoRoot = (Get-Location).Path
$worktree = Join-Path $env:TEMP ("apex-m0-baseline-" + [guid]::NewGuid().ToString("N"))
git worktree add --detach $worktree 00ba4d48
Set-Location (Join-Path $worktree "templates/full-stack-express")

function Invoke-Benchmark {
  param([string]$Name, [string[]]$PnpmArgs)
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  & corepack pnpm @PnpmArgs
  $exitCode = $LASTEXITCODE
  $timer.Stop()
  Write-Output ("M0_BENCHMARK {0}_ms={1} exit={2}" -f $Name, $timer.ElapsedMilliseconds, $exitCode)
}

Invoke-Benchmark "install_fresh_workspace" @("install", "--frozen-lockfile")
Invoke-Benchmark "install_warm" @("install", "--frozen-lockfile")
Invoke-Benchmark "build_first" @("build")
Invoke-Benchmark "build_warm" @("build")
Invoke-Benchmark "check_first" @("check")
Invoke-Benchmark "check_warm" @("check")
Invoke-Benchmark "test_first" @("test")
Invoke-Benchmark "test_warm" @("test")

Set-Location $repoRoot
git worktree remove --force $worktree
```

This is a fresh-workspace measurement with a retained machine-level pnpm store and network cache. It is not labeled as a fully cold network install.

Results:

- Fresh-workspace install: 187.258 seconds, exit 0
- Warm install: 3.434 seconds, exit 0
- First build: 39.397 seconds, exit 0
- Warm build: 39.033 seconds, exit 0
- First check: 61.743 seconds, exit 1
- Warm check: 37.824 seconds, exit 1
- First test: 153.241 seconds, exit 1
- Warm test: 135.779 seconds, exit 1

The current toolchain has no meaningful build-task cache: the second build is effectively the same duration as the first.

### Check failure

`corepack pnpm check` stops in ESLint:

```text
apps/web/src/api/apiClient.ts
14:10 error Read import.meta.env only in apps/web/src/config/env.ts no-restricted-syntax
```

This is pre-existing baseline debt introduced by the preview sample-mode path. It must be green before the Vite+ migration can claim parity.

### Test failure

First run:

- Test files: 16 failed, 65 passed, 1 skipped
- Tests: 25 failed, 596 passed, 5 skipped

Warm run:

- Test files: 17 failed, 64 passed, 1 skipped
- Tests: 25 failed, 596 passed, 5 skipped

Failure groups include:

- committed OpenAPI formatting/generation drift
- migration-validation fixture drift
- UI package export-surface drift
- preview environment parity
- several child-process and startup tests exceeding their 10–20 second Windows deadlines
- framework guard timeouts

The warm run changes the failed-file count while preserving the failed-test count, which demonstrates timing sensitivity. The supply-chain suite does not run because the primary suite exits first.

Milestone 1 must not hide these failures or use Vite+ caching to replay them. Characterization work should separate deterministic contract drift from workstation timeout sensitivity.

## Recommended Pilot Operating Defaults

- Session unit: one immutable sandbox and database per build revision
- Concurrency: 2 sessions/requester, 4/project, 8/platform
- Provisioning concurrency: 4 platform-wide
- Revision replacement: one temporary overlap; previous verified preview remains available
- Readiness objective: P95 at 90 seconds
- Provisioning hard timeout: 180 seconds
- Published browser-proof objective: P95 at 150 seconds
- Idle TTL: 30 minutes
- Absolute TTL: 8 hours
- Superseded revision grace: 5 minutes
- Cleanup objective: all resources gone within 10 minutes
- Region: one pilot region colocated with Apex, Blob, gateway, and preview PostgreSQL
- View access: requester and project-assigned users with `builds:view`
- Control access: requester and project/super administrators
- Launch ticket: single use, 60 seconds
- Gateway session: host-only cookie, renewable for 15 minutes, bounded by instance TTL
- Identity: pseudonymous synthetic subject per viewer and instance; separate verifier principal
- Egress: denied by default
- Data: one database and role per instance on a shared preview-only PostgreSQL server

## Azure Protocol Decision

### Custom Dynamic Sessions

Rejected as the direct browser runtime:

- custom application endpoints document GET and POST only
- every request requires an Entra token and session identifier
- the management token must stay on the server
- cookies, CORS preflight, SSE, WebSockets, payload limits, and custom-domain ingress are not documented as a supported browser contract

Dynamic Sessions may still be useful for bounded server-to-server jobs, but it does not meet this preview requirement.

### Azure Container Apps Sandboxes

Selected for the isolated pilot:

- generally available since September 23, 2026
- custom OCI workloads
- hardware-isolated microVMs
- process, file, and port operations
- granular per-sandbox egress controls

Not approved for production:

- no availability SLA
- complete browser-ingress contract is not documented

The pilot must prove HTTP methods, OPTIONS/CORS, cookies, SSE, WebSockets, payload sizes, gateway routing, private PostgreSQL, latency, duplicate operations, and cleanup.

## Accepted ADRs

- `design-docs/build-preview-sandbox-ownership-adr.md`
- `design-docs/build-preview-provider-boundary-adr.md`
- `design-docs/build-preview-origin-access-adr.md`
- `design-docs/build-preview-data-isolation-adr.md`

## Explicit Conditions Carried into Milestone 1 and 2

The following are test conditions, not assumed facts:

- Azure Container Apps Sandboxes can support the required browser protocol through the selected gateway.
- Partitioned or other short-lived preview sessions work in the managed browser fleet.
- Shared preview PostgreSQL can create, migrate, seed, and drop isolated databases inside the readiness objective.
- The selected Azure region offers all required preview resources and meets data-residency requirements.
- Pilot quotas and TTLs meet actual utilization and cost needs.
- Regular Container Apps may run generated code only after the repository is explicitly classified as trusted.
- A production provider is not selected until the pilot passes and the service support/SLA is acceptable.

## Milestone 0 Exit Check

- Decisions approved: yes, by the Phase 2 product owner on 2026-11-05
- Baseline reproducible: yes for the recorded workstation and database state; no deployed-preview sample exists, so reliability and deployment-latency claims remain explicitly unavailable
- Hidden implementation assumptions: none identified; unresolved provider and browser behaviors are explicit pilot gates

Milestone 1 may start with the completion-invariant tests and local Docker walking skeleton. Cloud infrastructure work remains out of scope until the local browser-proven path passes.
