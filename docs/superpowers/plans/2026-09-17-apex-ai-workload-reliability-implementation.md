# Apex AI Workload Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove AI execution and high-frequency orchestration from App Service,
preserve every accepted run through component failures, and support concurrent
document, visual, and interactive AI workloads without cascading outages.

**Architecture:** App Service remains the authenticated API and streaming tier.
An ingress-free orchestrator controls durable Service Bus commands, checkpoints,
terminal results, Blob artifacts, and PostgreSQL state. Container Apps Jobs run
document and visual workloads; separate warm Container Apps run fast and
agentic interactive turns.

**Tech Stack:** React, Express, TypeScript, PostgreSQL/Drizzle,
node-pg-migrate, Azure App Service, Azure Container Apps and Jobs, Dapr, Azure
Managed Redis, Azure Service Bus, Azure Blob Storage, Terraform, GitHub Actions,
Application Insights, and Log Analytics.

## Global Constraints

- No Terraform apply until R0 is reconciled and its refreshed plan completes.
- No existing production resource is destroyed before the full mixed test,
48-hour soak, and rollback observation window pass.
- Every file change requires user permission before editing.
- Protected configuration and pipeline files require explicit permission.
- App Service must not execute Cursor SDK, CLI, Bedrock, repository
materialization, watcher, reaper, or finalization work in the target state.
- AI execution workers must not connect to PostgreSQL.
- Workers communicate state through Service Bus and artifacts through Blob.
- Delivery is at least once; all consumers are idempotent and dispatch-fenced.
- A missed checkpoint alone must never mark a worker lost.
- Production's temporary worker-heartbeat timeout is 600,000 ms.
- The active production database is `psql-apex-cus` in Central US.
- The stopped `psql-apex-eus2` server must not be deleted while Terraform state
owns it or any consumer still connects to it.
- Normal document worker deadline is 60 minutes; Job timeout is 70 minutes.
- Large document worker deadline is 120 minutes; Job timeout is 130 minutes.
- Fast interactive active-turn deadline is 5 minutes.
- Agentic interactive active-turn deadline is 20 minutes, including repository
preparation.
- Visual-generation concurrency starts at 2 and advances to 4 only through the
Bedrock gate.
- Rollout uses additive resources, versioned transports, canaries, and explicit
rollback switches.

---



## Verified starting point

The authoritative baseline is
`docs/superpowers/plans/2026-09-17-apex-ai-reliability-r0.md`.

Key blockers:

- Resolved 2026-09-17: Terraform state now owns `psql-apex-cus`, no longer
owns stopped `psql-apex-eus2`, and the refreshed production plan reports no
changes.
- Resolved 2026-09-17: production and staging use the 600,000 ms heartbeat
  mitigation, and the deployment workflow owns the same default for both slots.
- The active database has 859 maximum connections, not 300.
- Existing Container Apps environments are not zone redundant.
- Service Bus and shared storage are in East US; App Service and the active
database are in Central US; Redis is locally redundant in North Central US.
- A Central US single-primary-region target therefore requires new or migrated
AI data-plane resources rather than only reusing the current ones.



## Program decomposition

This master plan coordinates nine independently reviewable child plans:

1. Production state and deployment ownership reconciliation
2. Immediate Phase 0 safety
3. Durable run protocol and persistence
4. V2 Azure infrastructure
5. Orchestrator service
6. Document and visual workers
7. Interactive reliability and split lanes
8. Non-breaking migration and legacy retirement
9. Capacity, failure injection, and soak verification

Each child plan must be approved before its files are edited.

---



### Task 1: Reconcile production database and Terraform ownership

**Status:** Complete for this branch.

**Files:**

- Modify with separate approval: `infra/main.tf`
- Modify with separate approval: `infra/variables.tf`
- Modify with separate approval: `infra/outputs.tf`
- Modify with separate approval: `infra/terraform.tfvars.example`
- Modify with separate approval: `infra/README.md`
- Modify locally, never commit secrets: `infra/terraform.prd.tfvars`
- Create: `docs/superpowers/plans/2026-09-17-apex-database-state-reconciliation.md`

**Interfaces:**

- Consumes: verified R0 inventory and current `prd` Terraform state
- Produces: Terraform configuration/state that owns `psql-apex-cus` and no
longer owns `psql-apex-eus2`

- [x] Capture and securely back up the current local production state.
- [x] Inventory every state address under the old PostgreSQL server.
- [x] Inventory the active Central US server, database, firewall rules, SKU,
  storage, backup, and networking.
- [x] Verify all known live database consumers point to Central US; retain the
  old server's historical connection evidence in its decommission record.
- [x] Parameterize PostgreSQL storage and backup settings so configuration can
  match the 128 GiB/30-day active server without replacement.
- [x] Update the uncommitted production variable values to the active Central US
  server.
- [x] Write the exact state removal/import runbook.
- [x] Review and approve the exact state operations with the user.
- [x] Remove old PostgreSQL child resources from state without destroying live
  Azure resources.
- [x] Import the Central US server and database into their intended addresses.
- [x] Import only the firewall rule Terraform will continue to own.
- [x] Run a refreshed production plan.
- [x] Require zero unintended creates, replacements, or destroys.
- [x] Confirm production and staging continue using `psql-apex-cus`.
- [x] Confirm the GitHub production database hostname guard exists and targets
  the same production host.
- [x] Confirm the next production deployment passes the hostname guard
  ([run 35265446952](https://github.com/ryamiller-amergis/Apex/actions/runs/35265446952)).

**Verification:**

```text
terraform workspace show
terraform state list
terraform plan -no-color -detailed-exitcode -var-file=terraform.prd.tfvars
```

Expected result: workspace `prd`; refreshed plan completes; no unintended
replacement or destroy.

---



### Task 2: Make Phase 0 protections durable

**Status:** Complete for this branch; rollout gates remain before any capacity
increase.

**Files:**

- Modify: `src/server/services/designDocService.ts`
- Modify: `src/server/services/startupRecovery.ts`
- Modify: `src/server/services/agentRunReaperService.ts`
- Modify: `src/server/services/serviceBusPublisher.ts`
- Modify: `src/server/routes/api.ts`
- Modify with separate approval: `src/server/index.ts`
- Modify: `src/server/db.ts`
- Modify: `src/server/db/schema.ts`
- Create: `src/server/services/dbPoolTelemetry.ts`
- Create: `migrations/<timestamp>_agent-run-control-plane-indexes.js`
- Modify with separate approval: `.github/workflows/deploy.yml`
- Modify with separate approval: `infra/main.tf`
- Modify with separate approval: `.env.example`
- Test: `src/server/__tests__/designDocService.test.ts`
- Test: `src/server/__tests__/startupRecovery.test.ts`
- Test: `src/server/__tests__/agentRunReaperService.test.ts`
- Test: `src/server/__tests__/serviceBusPublisher.test.ts`
- Test: `src/server/__tests__/healthDb.test.ts`
- Test: `src/server/__tests__/dbPoolTelemetry.test.ts`

**Interfaces:**

- Consumes: current v1 worker and watcher behavior
- Produces: bounded v1 behavior safe enough to operate during V2 delivery

- [x] Write failing tests proving one logical watcher owner across instances.
- [x] Replace overlapping async watcher ticks with completion-scheduled ticks.
- [x] Add a top-level watcher error boundary and database-failure backoff.
- [x] Collapse repeated run-state reads into one snapshot query.
- [x] Add the latest-run-by-thread and transient-document indexes.
- [x] Leader-elect recovery and reaper sweeps.
- [x] Bound startup recovery by category and batch size; retain the approved
  leader-only full V1 reaper scan until V2 adds an indexed `next_action_at`.
- [x] Make `/api/health/live` process-only.
- [x] Keep bounded database readiness separate from external-dependency health.
- [x] Rebuild the Service Bus publish request and token per retry.
- [x] On one 401/403, invalidate the credential once before durable recovery
  takes over.
- [x] Change the code heartbeat fallback from 90,000 to 600,000 ms.
- [x] Add `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS=600000` to both slot deployment
  contracts.
- [x] Mark the heartbeat setting sticky.
- [x] Add safe database-pool aggregates to telemetry and agent health.
- [x] Run the isolated watcher/reaper/publisher/health suites (353 tests passed
  together on 2026-09-17).

**Rollout gates (not branch implementation):**

- [ ] Verify staging and production retain the same heartbeat value through a
  swap test.
- [ ] Run a 25-document v1 regression test before increasing any capacity.

---



### Task 3: Add durable run protocol tables and contracts

**Status:** Complete for this branch (persistence contracts only; no live V2
routing, Azure provisioning, or production migration).

**Files:**

- Modify: `src/server/db/schema.ts`
- Create: `migrations/20260917220000_ai-run-v2-control-plane.sql`
- Create: `migrations/20260917221000_ai-run-v2-active-thread-index.js`
- Create: `src/shared/types/aiRunV2.ts`
- Create: `src/server/services/aiRunV2/outboxRepository.ts`
- Create: `src/server/services/aiRunV2/inboxRepository.ts`
- Create: `src/server/services/aiRunV2/distributedLeaseRepository.ts`
- Create: `src/server/services/aiRunV2/runAttemptRepository.ts`
- Create: `src/server/services/aiRunV2/artifactManifest.ts`
- Test: `src/server/__tests__/aiRunV2Types.test.ts`
- Test: `src/server/__tests__/aiRunV2PersistenceContracts.test.ts`
- Test: `src/server/__tests__/aiRunV2ArtifactManifest.test.ts`
- Test: `src/server/__tests__/aiRunV2DistributedLeaseRepository.test.ts`
- Test: `src/server/__tests__/aiRunV2OutboxRepository.test.ts`
- Test: `src/server/__tests__/aiRunV2InboxRepository.test.ts`
- Test: `src/server/__tests__/aiRunV2RunAttemptRepository.test.ts`
- Test: `tests/integration/ai-run-v2-persistence.integration.test.ts`

**Interfaces:**

- Produces:
  - Transactional outbox rows
  - Idempotent inbox event claims
  - Permanent seeded lease rows with fencing tokens
  - Versioned run attempts
  - `http-files-v1` and `servicebus-blob-v2` transport markers
  - `checking_worker`, `finalizing`, and terminal failure categories

- [x] Define exact V2 command, checkpoint, result, and manifest schemas.
- [x] Add one-active-run-per-thread enforcement.
- [x] Add permanent seeded leases for admission, recovery, reaper, and outbox.
- [x] Enforce update-only lease acquisition/renewal for application roles.
- [x] Keep acquisition and renewal as distinct atomic statements.
- [x] Use PostgreSQL time and a non-resetting bigint fencing token.
- [x] Add an abort signal for lost long-running leases.
- [x] Add idempotent inbox event IDs and monotonic checkpoint sequences.
- [x] Add attempt-scoped dispatch fences.
- [x] Add artifact status distinct from execution status.
- [x] Add integration tests for duplicates, stale fences, lease takeover, and
  split-brain behavior.

**Verification evidence (2026-09-18, branch `tbi/infra-changes`):**

- Unit suites: 30 passed (`aiRunV2*` focused Jest run).
- Integration: 8 passed against approved `aipilot_e2e` only
  (`ai-run-v2-persistence.integration.test.ts`).
- V1 regression: 166 passed (lifecycle / ingest / reaper / publisher).
- `npm run build:server` and `git diff --check` clean after formatting.
- Local commits `f066f608`..`cf696cf6` (contracts through integration proof).

---



### Task 4: Provision the V2 Azure foundation

**Status:** Complete for this branch (Terraform + tests only; no apply until
separate approval).

**Locked decisions (2026-09-18):**

- **Service Bus:** new Central US Standard namespace (1A). Existing East US
  `sbns-apex-ai-*` stays live for V1 traffic.
- **Artifact storage:** new Central US StorageV2 account with private
  `ai-run-artifacts` (2A). Existing East US shared async storage stays live.
- **Cutover:** additive only. Do not stop or delete V1 messaging, storage,
  CAE/Jobs/interactive/Redis, or App Service AI wiring in Task 4. After V2 is
  proven in production, a later approved task stops old resources for an
  observation window, then deletes them under a separate runbook.

**Files:**

- Create: `infra/ai-platform-v2.tf`
- Create: `infra/ai-platform-v2-networking.tf`
- Create: `infra/ai-platform-v2-identities.tf`
- Create: `infra/ai-platform-v2-monitoring.tf`
- Create: `infra/ai-platform-v2-contracts.json`
- Modify with separate approval: `infra/variables.tf`
- Modify with separate approval: `infra/outputs.tf`
- Modify with separate approval: `infra/terraform.tfvars.example`
- Modify with separate approval: `infra/README.md`
- Test: `src/server/__tests__/aiPlatformV2Infrastructure.test.ts`

**Interfaces:**

- Produces:
  - Zone-redundant Central US V2 Container Apps environment
  - `/25` Container Apps subnet
  - Separate App Service and private-endpoint subnets
  - Orchestrator, document, visual, fast-interactive, and agentic identities
  - AI artifact Blob container
  - V2 queue entities
  - Monitoring resources

- [x] Decide, with explicit cost approval, whether V2 uses a new Central US
  Standard Service Bus namespace or intentionally retains East US messaging.
- [x] Decide, with explicit migration approval, whether V2 AI artifacts use a
  new Central US storage account or intentionally retain East US storage.
- [x] Create the V2 environment with zone redundancy enabled at creation.
- [x] Add Consumption and repo-read workload profiles.
- [x] Configure Log Analytics using resource-specific tables.
- [x] Add private `ai-run-artifacts` storage with lifecycle rules.
- [x] Create document, visual, fast, agentic, checkpoint, and result queues.
- [x] Enable duplicate detection on commands and terminal results only.
- [x] Keep sessions and checkpoint duplicate detection disabled.
- [x] Add entity-scoped managed-identity role assignments.
- [x] Keep public endpoints during the first functional smoke.
- [x] Add private endpoints later as an independent, reversible phase.
- [x] Add Terraform tests for immutable queue and environment properties.

**Verification evidence (2026-09-18, branch `tbi/infra-changes`):**

- Gated by `enable_ai_platform_v2` (default false); V1 resources untouched.
- `terraform validate` succeeds (CAE via AzAPI for immutable `zoneRedundant`).
- Contract suite: 8 passed (`aiPlatformV2Infrastructure.test.ts`).
- No Terraform apply performed.

**Deferred Azure apply (do NOT do during Tasks 5–8 code work):**

Hold until remaining V2 **code** work is done, the branch is pushed, and
dev/staging app deploys are healthy. Then create cloud resources in a
separate ops pass:

1. Set `enable_ai_platform_v2 = true` in the approved workspace tfvars.
2. Set network: `ai_platform_v2_create_network = true` **or**
   `ai_platform_v2_infrastructure_subnet_id` (ZR CAE needs a `/25` subnet).
3. Set logging: existing `ai_platform_v2_log_analytics_workspace_id` **or**
   `ai_platform_v2_create_log_analytics_workspace = true`.
4. Keep `ai_platform_v2_internal_load_balancer = false` for first public smoke.
5. Review `terraform plan` (expect creates only for V2; **zero** destroys of
   V1 East US SB / shared storage / existing CAE).
6. Obtain **separate explicit apply approval**, then apply to staging first.
7. Smoke V2 resources; only later promote apply to production under the same
   additive rules.
8. V1 stop/delete remains Task 8 + soak + a further deletion approval — not
   part of the first V2 apply.

---



### Task 5: Build the orchestrator

**Status:** Complete for this branch (separate process + unit tests only; no
App Service wiring, no deploy.yml, no Azure apply).

**Files:**

- Create: `src/server/services/aiOrchestrator/orchestrator.ts`
- Create: `src/server/services/aiOrchestrator/outboxDrainer.ts`
- Create: `src/server/services/aiOrchestrator/admissionController.ts`
- Create: `src/server/services/aiOrchestrator/checkpointConsumer.ts`
- Create: `src/server/services/aiOrchestrator/resultConsumer.ts`
- Create: `src/server/services/aiOrchestrator/reconciler.ts`
- Create: `src/server/services/aiOrchestrator/providerGovernor.ts`
- Create: `src/server/services/aiOrchestrator/entrypoint.ts`
- Create: `src/server/services/aiOrchestrator/outboxNotify.ts`
- Create: `src/server/services/aiOrchestrator/serviceBusRestClient.ts`
- Create: `src/server/services/aiOrchestrator/metrics.ts`
- Create: `src/server/services/aiOrchestrator/ports.ts`
- Create: `src/server/services/aiOrchestrator/types.ts`
- Create: `runners/ai-orchestrator/Dockerfile`
- Create: `scripts/ci/publish-ai-orchestrator.sh`
- Deferred (separate approval): `.github/workflows/deploy.yml`
- Test: `src/server/__tests__/aiOrchestrator/*.test.ts`

**Interfaces:**

- Consumes: outbox, V2 queues, Blob manifests, provider/lane capacities
- Produces: dispatches, checkpoints, finalized runs/documents, alerts

- [x] Wake the outbox drainer with PostgreSQL NOTIFY.
- [x] Add a 30-second leased safety sweep.
- [x] Claim bounded outbox batches with `SKIP LOCKED`.
- [x] Enforce provider and lane floors with borrowable shared capacity.
- [x] Start Cursor provider cap at 20 and Bedrock at 2.
- [x] Batch checkpoint persistence.
- [x] Keep checkpoint and terminal consumer pools separate.
- [x] Move stale runs to `checking_worker` after missed checkpoints.
- [x] Require positive Container Apps execution confirmation for
  `worker_lost`.
- [x] Pause background dispatch at two uncertain workers.
- [x] Finalize terminal results transactionally and idempotently.
- [x] Dead-letter poison messages and terminalize the user-visible run.
- [x] Emit control-plane QPS, queue age, lease, provider, and finalization
  metrics.

**Verification evidence (2026-09-21, branch `tbi/infra-changes`):**

- Orchestrator unit suites + outbox notify regression: 16 passed.
- `npm run build:server` clean.
- Entrypoint is **not** started from App Service `index.ts`.
- deploy.yml and Azure apply remain deferred.

**Follow-ups closed 2026-09-21 (all inside the V2-only folders, which nothing
in the running App Service imports):**

- [x] Dispatch commands now carry `workloadLane`, so each lane reaches its own
  command queue and its own capacity floor. Previously the lane never reached
  the outbox payload and every V2 dispatch would have landed on the document
  queue. A command with no recognizable lane is denied as `unknown_lane`
  rather than published to a guessed queue.
- [x] `acceptCheckpoint` folds the started checkpoint's execution id into
  `spec_ref`, which is the only place the reconciler can read it. The
  orchestrator also had the field misspelled `containerAppExecutionId`
  against the contract's `containerAppsExecutionId`, so the probe could never
  have found an id even once workers published one.
- [x] Live per-provider and per-lane counters replace the empty utilization
  placeholder, so the Cursor 20 / Bedrock 2 caps bind at runtime. Counts join
  attempts back to the originating outbox row; no schema change was needed.

**Still open before any staging run:**

- [ ] The execution probe answers `unknown` for everything, and the
  reconciler leaves `unknown` attempts alone, so nothing reaches
  `worker_lost` and two stuck attempts pause background dispatch. Blocked on
  Task 6 (workers must publish the execution id) and on Terraform defining
  the job to probe.

**Hosting and environment (not yet provisioned):**

- [ ] No compute resource exists for the orchestrator.
  `ai-platform-v2-identities.tf` grants it queue and blob roles, but no
  Container App is defined; the cost gates assume two warm replicas.
- [ ] `scripts/ci/publish-ai-orchestrator.sh` is never called — `deploy.yml`
  has no orchestrator references and no registry repository name is chosen.
- [ ] Environment contract is undocumented (`.env.example` is protected):
  `AI_PLATFORM_V2_SERVICEBUS_NAMESPACE` (falls back to
  `AI_RUNS_SERVICEBUS_NAMESPACE`), `AI_PLATFORM_V2_CHECKPOINT_QUEUE`,
  `AI_PLATFORM_V2_RESULT_QUEUE`, `AI_ORCHESTRATOR_ENABLED`,
  `AI_ORCHESTRATOR_SB_MODE`, `DATABASE_URL`.

---



### Task 6: Build document and visual workers

**Status:** Worker side complete on this branch. The four live V1 files are
not yet modified — see "Remaining for Task 6" below.

**Files:**

- Create: `src/server/services/aiRunsV2Worker/serviceBusClient.ts`
- Create: `src/server/services/aiRunsV2Worker/specificationClient.ts`
- Create: `src/server/services/aiRunsV2Worker/checkpointPublisher.ts`
- Create: `src/server/services/aiRunsV2Worker/resultPublisher.ts`
- Create: `src/server/services/aiRunsV2Worker/artifactUploader.ts`
- Create: `src/server/services/aiRunsV2Worker/documentEntrypoint.ts`
- Create: `src/server/services/aiRunsV2Worker/visualEntrypoint.ts`
- Create: `runners/ai-runs-documents-v2/Dockerfile`
- Create: `runners/ai-runs-visual/Dockerfile`
- Create: `scripts/ci/publish-ai-runs-documents-v2.sh`
- Create: `scripts/ci/publish-ai-runs-visual.sh`
- Modify: `src/server/services/backgroundWorkflowRouter.ts`
- Modify: `src/server/services/designPrototypeService.ts`
- Modify: `src/server/services/uiLabService.ts`
- Modify: `src/server/routes/uiLab.ts`
- Test: `src/server/__tests__/aiRunsV2Worker/*.test.ts`

**Interfaces:**

- Consumes: immutable Blob execution specifications and fenced commands
- Produces: checkpoints, immutable artifacts, terminal results

- [x] Receive commands with peek-lock.
- [x] Publish a started checkpoint containing the Container Apps execution ID.
- [x] Complete the command only after the fenced attempt is durably started.
- [x] Publish checkpoints every 30 seconds.
- [ ] Use ephemeral local workspace and repo-read.
- [x] Enforce normal and large phase deadlines.
- [x] Upload files under attempt-scoped immutable Blob paths.
- [x] Write the manifest last.
- [x] Publish terminal result before process exit.
- [x] Use a new attempt and dispatch ID after confirmed post-claim loss.
- [x] Keep all PostgreSQL packages and connections out of worker entrypoints.
- [x] Start visual concurrency at two and implement automatic rollback from
  three/four on Bedrock throttling.

**Verification evidence (2026-09-21, branch `tbi/infra-changes`):**

- V2 suites: 81 passed, including a guard that walks the worker import graph
  and fails if any module in it imports a database module.
- `npm run build:server` clean.
- Neither entrypoint is started from App Service `index.ts`.

**Remaining for Task 6:**

- [x] Write the execution specification to Blob and dispatch a V2 attempt from
  the admission path (`specificationWriter.ts`, `v2AdmissionService.ts`). The
  specification is written under an if-none-match condition before the
  command references it, so a re-dispatched attempt reuses it rather than
  rewriting it.
- [ ] Wire each lane's `execute` to a provider. Both lanes currently publish a
  progress checkpoint and then refuse rather than invent output.
- [x] `backgroundWorkflowRouter.ts` chooses V2 behind `ai-runs-v2-transport`
  (default off) inside the existing `ai-runs-background` enabled branch. An
  unreadable V2 flag, a refused admission, or a thrown admission all keep the
  proven path: the first two stay on V1, the last two recover in-process.
- [ ] Route the visual lane. `designPrototypeService.ts`, `uiLabService.ts`,
  and `routes/uiLab.ts` never call `routeBackgroundWorkflow` — visual
  generation runs in-process today, so moving it onto the queue is new
  routing rather than a flag split on an existing one.

  **Decision (2026-09-21):** the owning service applies its own artifacts. The
  orchestrator finalizes the attempt and knows nothing about prototypes; each
  service reads the manifest from Blob when it sees its run finish.
  `artifactReader.ts` provides the shared, checksum-verifying read.

  **Harvest built 2026-09-21 — the visual loop now closes.** A finished V2
  visual run reaches its `design_prototypes` row through the recovery sweep:

  - `aiRunV2/finishedAttemptReader.ts` answers "which of these threads have a
    finished V2 run?" and owns the harvest claim. It takes thread ids and
    returns manifest references, so it learns nothing about prototypes. An
    attempt is offered only when the run header **and** the attempt are both
    terminal — the reconciler's retry path fails an attempt and immediately
    dispatches a replacement, which returns the header to `dispatched`, and
    consuming the loser would apply a superseded run's output.
  - `designPrototypeV2Harvest.ts` reads `prototype.html` through
    `artifactReader`, sanitizes it, and writes the same row
    `generateSinglePrototype` writes on success (`mockHtml`, `mockVersion: 1`,
    a single version-1 history entry, `pending_review`, `generationError: null`),
    then records the cost from `usage.json` and fires the completion
    notification.
  - `startupRecovery.recoverInFlightWork` drives it, immediately **before**
    `failStalePrototypes`. That ordering matters: a run that finishes just past
    the 25-minute staleness threshold would otherwise be failed in the same
    cycle that could have applied it.

  **Why the recovery sweep and not a new consumer.** It already runs every 60
  seconds behind a single-owner lease (`startup-recovery:sweep`), already calls
  into `designPrototypeService` for exactly this class of problem, and is
  already started from the protected `index.ts`. A live `subscribeRunEvents`
  subscription loses the event whenever the finishing instance is not the
  admitting one; a durable replay over `agent_run_events` would need a new
  per-consumer cursor and would still have to read `ai_run_attempts.manifest_ref`
  afterwards. The attempt table is the durable record, so the sweep queries it
  directly.

  **Exactly-once — two independent guards, both existing patterns:**

  1. A durable claim per attempt in `ai_run_inbox`, keyed
     `artifact-harvest:{attemptId}` under the new `artifact_harvest` kind. The
     table already models idempotent consumption, including the
     claimed-but-never-processed case, which is retried rather than abandoned.
     The claim is what stops a superseded attempt being re-applied later:
     `retryPrototype` puts a row back to `generating` and regenerates
     **in process**, leaving the old terminal V2 attempt as the newest one on
     `prototype:{id}`.
  2. A compare-and-set on the prototype row (`WHERE status = 'generating'`), so
     the apply and "has this already been applied?" are one statement. Only the
     writer that wins it records usage, so cost cannot be charged twice, and the
     history entry is a replacement rather than an append. The CAS is restricted
     to `generating` deliberately: a version-1 replacement would discard a
     regeneration's history, and the V2 lane admits initial generation only.

  Correctness does not depend on the claim alone — a lost claim still cannot
  double-write, because the CAS refuses the second apply.

  **Failure handling.** A `failed` or `cancelled` attempt never reaches the
  artifact read; the prototype is marked `generation_failed` with the attempt's
  own failure detail. `ArtifactVerificationError` is terminal for the apply:
  the bytes will never match on a later read, so the prototype is failed with
  the verification message rather than left in `generating`, and the claim is
  closed. Any other read error (a transient Blob fault) leaves the claim open
  and the next sweep retries.

  `VISUAL_USAGE_FILE_NAME` moved to `src/shared/types/aiRunV2VisualSpec.ts` so
  the worker and the harvest name one file; `visualEntrypoint.USAGE_FILE_NAME`
  re-exports it. Nothing under `aiRunsV2Worker/` gained a database import — the
  guard suite still passes.

  **Still open after the harvest:**

  - Only prototypes are harvested. Document runs routed through
    `backgroundWorkflowRouter` onto V2 have no equivalent consumer, and
    `uiLabService` still admits nothing — see the UI Lab note below.
  - `failStalePrototypes` uses a 25-minute threshold measured from
    `design_prototypes.updatedAt`, but a V2 run's own deadline is
    `resolveAgentRunHardLimitMs()` (2 hours by default). A visual run that
    legitimately outlives 25 minutes has its prototype failed while the run is
    still going; the harvest then finds a completed attempt whose prototype is
    `generation_failed` and the CAS correctly refuses to overwrite the
    user-visible failure. The transport and the staleness sweep need one shared
    deadline.
  - A run that finishes while its prototype is **not** in `generating` (the user
    reset it first) is never claimed. A later retry that puts the row back to
    `generating` can then have the older artifact applied to it, racing the
    in-process retry. Neither outcome corrupts the row — both write a single
    version-1 history entry, and each run records only its own real cost — but
    the winner is whichever finishes last.
  - Nothing reclaims the Blob artifacts of a harvested attempt; lifecycle rules
    on the container are the only cleanup.

  **Three blockers found (2026-09-21), in the order they must be cleared:**

  1. Visual generation is entangled with the database. `bedrockService.ts`
     reads `getFigmaReference`, `getMaxviewColorTokens`,
     `getDesignSystemCatalog`, `getScreenInventory`, and
     `resolvePrototypeExtendMode` inline, at roughly ten call sites deep
     inside its prompt builders, and writes usage with `recordAiUsage`. A
     worker importing it pulls PostgreSQL in and the isolation guard fails.
     `src/shared/types/aiRunV2VisualSpec.ts` defines the shape those reads
     collapse into: context resolved on the App Service side, usage
     attribution travelling back with the terminal result. The refactor of
     `bedrockService` to build prompts from that specification alone is the
     bulk of the remaining work.
  2. Runs are keyed by thread and a unique index allows one active V2 run per
     thread, but a PRD generates many prototypes concurrently. Each needs its
     own run identity (for example `prototype:{prototypeId}`) or the second
     admission is refused as a conflict.
  3. Completion convergence — see the note under Task 8 below.

  **UI Lab onto the visual lane (2026-09-21) — half built, and the reason it
  stops there.**

  Built:

  - `visualEntrypoint.buildVisualPrompt` dispatches on `subjectKind` with a
    `never` check. It did not before: `createVisualExecute` called
    `buildPrototypePrompt` unconditionally while
    `aiRunV2VisualSpec.ts` had declared `'design-prototype' | 'ui-lab-screen'`
    since it was written. A UI Lab specification would have been answered with
    prototype instructions — four state sections, the purple NEW annotation,
    the MaxView shell — and the result uploaded as a finished artifact with
    nothing raised anywhere. Closed before anything else.
  - `aiRunsV2Worker/uiLabPromptBuilder.ts` ports `buildContextSection` and
    `buildGenerationPrompt` out of `uiLabBedrockService`, prose copied rather
    than rewritten. No database import; the guard suite still passes.
  - `buildUiLabVisualSpecification` fills exactly the `promptInputs` keys the
    worker reads, asserted through the built prompt so a rename on either side
    fails a test instead of dropping a prompt section in silence. Output path
    is `design.html`.
  - `visualRunThreadId` now takes the subject kind and switches exhaustively.
    It hardcoded `prototype:`, so a UI Lab run admitted through it would have
    landed in the prototype namespace — harmless only because the prototype
    harvest keys off `design_prototypes` rows, and a trap for whoever wires
    admission next.

  **Not built: admission, the App Service context loader, and the harvest.**
  UI Lab is not prototype work with a different prompt. Every generation is
  driven by `GET /api/ui-lab/:id/stream`, which holds an SSE connection open
  and forwards Bedrock tokens to `useUiLabStream`, which renders the partial
  HTML into the canvas as it arrives. `runGeneration` has no other caller.
  V2 cannot carry that: the worker uploads a finished artifact to Blob, the
  orchestrator finalizes the attempt, and the owning service applies it from
  the 60-second recovery sweep. There is no token channel back to a waiting
  browser, and up to 60 seconds of dead air after the model has already
  finished. Wiring admission without settling this would trade a live stream
  for a blank screen and call it a transport change.

  Three decisions belong to whoever picks this up, none of them mine to make
  quietly:

  1. **Does UI Lab give up live streaming?** If yes, `useUiLabStream` and the
     two SSE routes come out and the existing `refetchInterval` polling in
     `useUiLabDesigns` carries the result — a client change, and a visible
     downgrade for the author watching. If no, the visual lane needs a
     progress channel (the checkpoint queue already carries progress;
     nothing forwards it to a browser).
  2. **Harvest cadence.** 60 seconds is invisible for a batch of prototypes
     nobody is watching. It is not acceptable for a user at a screen. Either
     UI Lab gets an event-driven apply or the sweep interval changes for
     everything.
  3. **`ai-runs-v2-transport` is one flag**, already shared by the document
     lane and the visual lane. Adding UI Lab to it means enabling V2 for
     PRDs also degrades UI Lab's UX in the same switch. UI Lab needs its own
     flag or the existing one needs per-lane scoping.

  **Regeneration stays in process** either way, matching the prototype
  boundary: the V2 visual lane admits initial generation only, and the CAS in
  the harvest is restricted to the initial-generation status for the same
  reason.

  **Queue topology — recommendation: keep one `ai-runs-v2-visual` queue.**
  Not changed here; the queues live in `infra/ai-platform-v2-contracts.json`
  and the Terraform is not applied. Two separate queues would not buy
  isolation, because the contended resource is not the queue — it is the two
  Bedrock slots (`bedrockCap: 2`, `visual` lane floor 2 in
  `aiOrchestrator/types.ts`). A second queue drains into the same cap, so a
  batch of prototypes still starves an interactive UI Lab request; it would
  only add a queue, an identity, and a second consumer to operate. The real
  fix is priority *within* the lane: let UI Lab preempt or reserve one of the
  two slots, so a 20-prototype PRD cannot make an author wait behind it. Split
  the queue only if the lanes stop sharing a worker image or get separate
  provider caps — at which point they are no longer one lane.

  **Two things found that the visual lane already gets wrong for prototypes:**

  - ~~`bedrockVisualClient` sends `messages: [{ role: 'user', content: prompt }]`
    — a plain string, no image block.~~ **Fixed 2026-09-21.** Both in-process
    paths attach the Figma screenshot as a vision input (`bedrockService` for
    prototypes, `uiLabBedrockService` for UI Lab), and the prompt tells the
    model to match it — the ported colour rule says the reference screenshot
    is for layout only. A V2 prototype was being asked to match a screenshot
    it could not see, which is a silent output change hiding inside a
    transport change. The `screenshotBase64`, `screenshotMediaType`,
    `screenshotWidth` and `screenshotHeight` fields `VisualDesignReference`
    already declared are now produced and consumed end to end:

    - `designPrototypeService.loadPrototypeDesignContext` reads them off
      `getFigmaReference()`, where the App Service can reach it.
    - `visualSpecificationBuilder` carries them on `designReference` for both
      the prototype and UI Lab builders, so UI Lab inherits the fix when it
      is wired up. The fields are left off entirely when there is no
      screenshot, so a reference-less specification is unchanged.
    - `visualEntrypoint` resolves the image off the specification — never
      fetching it, which would break worker isolation — and
      `bedrockVisualClient` emits an Anthropic image block ahead of the text
      block, mirroring `bedrockService.invokeModel` including the ordering.
      With no image the message stays a plain string, as before.

    The image deliberately does not travel through
    `applyDesignContextBudget`: that budget sizes how much repository source
    fits, and counting a ~94 KB base64 screenshot against its 400 KB would
    push real source out of the prompt. Nothing caps the specification — the
    writer uploads it to Blob whole and the queue carries only a blob ref —
    so the added size is workable.

  - **Still open: the project-specific prototype prompt never reaches the
    worker.** In process, `generateDesignPrototypeHtml` branches to
    `buildProjectPrototypePrompt` when `prototypeContext` is set, dropping
    the MaxView catalog, palette, Figma reference and sidebar entirely, and
    can add `webReferences`. `buildPrototypePromptInputs` carries neither,
    and `admitPendingPrototypesToV2` excludes only EXTEND-mode features — so
    a project with its own design-system skill is admitted to V2 and answered
    with the MaxView prompt. Same class of defect as the image, wider blast
    radius.
  - **Still open: `stop_reason` is not read.** `bedrockService` throws
    `BedrockModelTruncatedError` on `stop_reason: 'max_tokens'`;
    `bedrockVisualClient` ignores it and returns the partial text, which the
    worker uploads and finalizes as a completed prototype.
  - ~~**Still open: `VisualModelSettings` has no `temperature`.**~~ Closed
    2026-09-22 — the contract carries an optional `temperature`,
    `resolveUiLabVisualModel` populates it from `uiLabBedrockTemperature`, and
    `bedrockVisualClient` adds the key to the payload only where it is set.
  - **Still open: one image, but EXTEND mode sends two.** The in-process
    prototype path can attach both the Figma reference and a per-route page
    screenshot from `pageScreenshotService`. `VisualDesignReference` holds one
    screenshot. Not live today — EXTEND falls back in process — but it
    becomes a gap the moment EXTEND is admitted.
  - `uiLabBedrockService.buildContextSection` joins `PageRoute` objects
    straight into the prompt, so "### Application routes" has always read
    `[object Object]`. Carried across verbatim and pinned with a test rather
    than fixed, because a transport move is the wrong place to change what the
    model is asked. `uiLabBedrockService.buildCatalogSection` is also dead —
    it builds an empty literal and nothing calls it.

  **A differential test for the whole class (2026-09-21).** Every defect above
  is the same species — an input channel the in-process path supplies that the
  V2 path drops — and each was found by hand, weeks apart. Unit tests missed
  all of them because they assert what the V2 code does, not whether it
  matches the path it replaced.
  `src/server/__tests__/designPrototypeBedrockRequestParity.test.ts` asserts
  the match instead: one PRD fixture drives `generatePrototypesForPrd` twice —
  once with `ai-runs-v2-transport` off, once on — and both Bedrock requests
  are captured and compared.

  - **Comparison point: the whole `InvokeModelCommand` payload** — model id,
    headers, every payload key, and every content block including images and
    their ordering. It is the last place the two paths converge before the
    network, so a dropped channel has nowhere left to hide. The composed
    prompt alone would have caught the wrong-prompt defects but not the
    missing image and not the token ceiling below.
  - **Seam: the AWS SDK client class, and nothing else.** `bedrockService`
    holds its client at module scope and `bedrockVisualClient` builds one when
    none is injected, so replacing the class observes both paths without
    either knowing it is under test and without touching `bedrockService`.
  - **Named allowances**, applied to both sides so an unexpected difference
    still fails: a bare-string `content` is canonicalised to a one-block text
    array, and the worker-only repository-source section is removed before the
    prompts are compared.
  - Both differential cases were **red on purpose** — one on the project
    design system above, one on the token ceiling below. The ceiling case went
    green on 2026-09-22; the project design system case is still red. The
    comparison names each divergence in a sentence, including the prompt line
    where two prompts first differ.

  **Found by that test, still open:**

  - ~~**The prototype output-token ceiling is halved on V2.**~~ Closed
    2026-09-22, see "A worker holds no policy" below.
  - The comment on `bedrockVisualClient.buildContent` — "With no image the
    message stays a plain string, which is what a reference-less in-process
    call sends" — is wrong. `bedrockService.invokeModel` always builds a block
    array, even with no images. The two encodings mean the same thing to the
    Bedrock Anthropic API, so this is a comment to correct rather than a
    defect, and the test carries it as a named allowance.
  - The payload is not the whole call. `bedrockService`'s throttle retry, which
    `bedrockVisualClient` has no equivalent of, sits outside this comparison
    and needs its own check. The per-attempt timeout was part of this gap and
    is now resolved on App Service like the ceiling; what remains is that the
    in-process timeout bounds each of up to five attempts while the worker
    gets one.

  **A worker holds no policy (2026-09-22).** The ceiling defect was not a
  wrong number, it was a worker deciding a number at all. Model settings have
  three layers — the project override in `project_skill_settings`, the app
  default in the owning service, and the environment variable that tunes it —
  and a worker can read none of them. `model.maxTokens ?? DEFAULT` then reads
  a missing field as configuration and answers with something plausible.

  - **Resolved on App Service, always on the specification.**
    `resolvePrototypeVisualModel` (in `bedrockService`) and
    `resolveUiLabVisualModel` (in `uiLabBedrockService`) each live beside the
    defaults their own in-process call applies, and each returns a complete
    `VisualModelSettings`. The prototype resolver calls the same two functions
    `generateDesignPrototypeHtml` and `invokeModel` call, so the two
    transports cannot land on different numbers without the shared function
    changing.
  - **Per lane, because the lanes differ.** Prototype: 32,000 tokens
    (`BEDROCK_UI_MOCK_MAX_TOKENS`) and a 12-minute timeout
    (`BEDROCK_INVOKE_TIMEOUT_MS`). UI Lab: 16,000 tokens
    (`BEDROCK_UI_LAB_MAX_TOKENS`) and a 10-minute timeout
    (`BEDROCK_UI_LAB_TIMEOUT_MS`). Collapsing them to one number truncates
    one lane or overspends on the other, which is why the 16k worker constant
    looked defensible.
  - **Override semantics are mirrored, not tidied.** The prototype path takes
    an override only when it is above zero; UI Lab takes any non-null value.
    Both are copied as they are, because matching the in-process request
    matters more than consistency between two lanes.
  - **`maxTokens` and `timeoutMs` are required on `VisualModelSettings`** and
    checked by `isAiRunV2VisualSpecification`, which the worker already runs
    before the model call. A specification that lost either is refused, and
    `DEFAULT_VISUAL_MAX_TOKENS` / `DEFAULT_VISUAL_TIMEOUT_MS` are deleted, so
    there is nothing left to fall back to.
  - **Known divergence, deliberate.** A project that sets
    `ui_lab_bedrock_max_tokens` to 0 would have the in-process path send
    `max_tokens: 0` and be rejected by Bedrock; on V2 the specification is
    refused at validation instead. Both fail; only the message differs.

- [ ] Ephemeral workspace and repo-read wiring for the worker processes.

---



### Task 7: Make interactive turns durable and split by cost

**Files:**

- Modify: `src/server/services/interactiveWorkflowRouter.ts`
- Modify: `src/server/services/interactiveActorAdmissionService.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- Modify: `src/server/services/interactiveActorHost/entrypoint.ts`
- Modify: `src/server/services/interactiveGatewayService.ts`
- Modify: `src/server/services/interactiveLiveBus.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/client/hooks/useAgentChatSession.ts`
- Modify: `src/client/hooks/useChatStream.ts`
- Modify: `src/client/components/ChatAgentPanel.tsx`
- Modify: `src/client/components/InterviewChatView.tsx`
- Modify: `src/client/components/AdrChatView.tsx`
- Test: existing interactive, chat, Interview, and ADR suites

**Interfaces:**

- Produces:
  - Fast and agentic cost classification
  - Durable queued interactive turns
  - Rehydration from PostgreSQL/Blob
  - Failed-run retry by run ID
  - WebSocket replay
  - No in-process fallback

- [ ] Classify the selected skill/model as fast or agentic.
- [ ] Enforce four-slot lane floors, shared normal capacity, and surge ceiling.
- [ ] Enforce two active turns per user and one agentic turn per user.
- [ ] Persist the message, run, and outbox atomically.
- [ ] Queue overflow rather than invoking App Service.
- [ ] Recreate an expired Cursor agent from the durable transcript.
- [ ] Include repository preparation inside the 20-minute agentic deadline.
- [ ] Enforce first-event and tool deadlines.
- [ ] Replace blind text resend with idempotent failed-run retry.
- [ ] Return `Thread not found` only for genuinely absent/inaccessible threads.
- [ ] Replay durable events after Redis/WebSocket interruption.
- [ ] Remove interactive App Service fallback only after all recovery tests pass.

---



### Task 8: Migrate without breaking active work

**Files:**

- Create: `docs/runbooks/ai-platform-v2-cutover.md`
- Create: `docs/runbooks/ai-platform-v2-rollback.md`
- Modify with separate approval: `.github/workflows/deploy.yml`
- Modify with separate approval: `infra/README.md`

**Interfaces:**

- Consumes: working v1 and proven V2 paths
- Produces: V2 production traffic with v1 rollback retained

**Resolved — V1/V2 completion convergence (raised 2026-09-21, settled
2026-09-21):**

Each transport keeps the terminal write it already had, and both now call
`agentRunTerminalEffects.applyTerminalRunEffects` once that write is durable.
`markTerminal` was not made the single owner: V2 finalizes the attempt row and
its run header in one transaction, and splitting them would let a crash leave
a finalized attempt on a still-running run.

The shared path publishes a durable `done` / `completion` run event,
deactivates grounding, logs the transition, and reports the terminal reason.
V1 passes `terminalEventsPersisted: true` because its completion handler
already persisted the events and idled the thread inside the terminal
transaction; the V2 result consumer passes `false` and the shared path
publishes the run's only terminal event.

Two deliberate exclusions, both documented in the module:

- Admission slot release stays in `markTerminal`. It publishes V1 dispatch
  messages, and V2 capacity is governed by the orchestrator's own utilization
  reader. V2 runs no longer occupy a V1 slot at all, so a finished one leaves
  nothing for the periodic sweep to reclaim.
- The reconciler's `failed` / `worker_lost` transition is not wired to the
  shared path, because it may be followed immediately by a replacement attempt
  that puts the run back to `dispatched`. Applying terminal effects there needs
  a check that no retry follows.

**Resolved — V1 schedulers no longer govern V2 runs (raised 2026-09-21,
settled 2026-09-21):**

`admissionGovernorService` and `agentRunReaperService` both selected on
`lane = 'background'` with no `transport_version` filter, so V1's schedulers
operated on V2 runs. Every selection in both services is now restricted to the
V1 transport:

- `readQueueSnapshot` excludes V2 from in-flight, queue depth, and
  oldest-queued age, so V2 work is no longer charged to both V1's cap and the
  orchestrator's utilization reader.
- `admitNext` excludes V2 from the fairness CTE and from candidate selection,
  so the governor can no longer claim a V2 run during the window where it is
  still `queued` and overwrite the fence its `ai_run_attempts` row holds.
- `findStaleDispatches` excludes V2, so the republish sweep cannot re-enqueue
  a V2 run onto the V1 queue.
- `reapOrphanedRuns` skips V2 rows before any clock is evaluated. The V1 queue
  TTL, dispatch TTL, cold-start republish, worker-heartbeat and
  worker-progress clocks all previously fired on V2 rows; the heartbeat clock
  fired unconditionally on any V2 run older than ten minutes, because a V2
  worker writes `last_checkpoint_at`, never `heartbeat_at`.

Liveness reads (`isThreadRunAlive`, `getThreadRunStateSnapshot`) are
deliberately unchanged: a V2 run in flight genuinely is alive, and waiters
must keep waiting for it.

**Open — a V2 attempt can be stranded in `queued` with no owner:**

`createQueuedV2Run` writes the run header and its first `ai_run_attempts` row
in one transaction, so a header without an attempt row cannot occur. The
reachable gap is narrower and one step later: `dispatchNextAttempt` runs in a
second transaction, and both callers of `v2AdmissionService.admit`
(`backgroundWorkflowRouter`, `designPrototypeService`) catch its failure and
fall back to in-process generation without removing the committed header. A
crash between the two transactions leaves the same state.

Nothing reclaims that state. The reconciler sweeps
`status IN ('dispatched', 'running')` and `status = 'checking_worker'`; a
`queued` attempt matches neither. Until the fix above, V1's queue TTL reaped
the header after thirty minutes — incorrectly, since it orphaned the attempt,
but it did release `uq_agent_runs_v2_active_thread`. That partial-index lock
now blocks every future V2 run on the affected thread permanently.

A fix was not attempted here because none of the options is small:
`queued -> checking_worker` is an illegal attempt transition, a new sweep
needs its own age budget measured from `created_at` rather than
`last_checkpoint_at` (a queued attempt has never checkpointed), and the
structurally correct fix — folding `dispatchNextAttempt` into
`createQueuedV2Run`'s transaction — changes the admission contract and the
reconciler's retry path, which reuses `dispatchNextAttempt` on its own.

- [ ] Record `transport_version` on every run.
- [ ] Keep old HTTP callbacks and Azure Files for v1 runs.
- [ ] Route only new canary runs to V2.
- [ ] Migrate document workloads in 3/6/10/12 steps.
- [ ] Migrate visual workloads at 2 before proving 3 and 4.
- [ ] Implement interactive rehydration before moving interactive compute.
- [ ] Deploy replacement Redis and interactive apps side by side.
- [ ] Stop new old-stack admissions and queue new turns.
- [ ] Drain active turns for up to 22 minutes.
- [ ] Switch dispatch pointers and run canaries.
- [ ] Keep old environments, Redis, queues, callbacks, and Azure Files through
  the full soak and observation period.
- [ ] Roll back immediately if any gate fails.

---



### Task 9: Prove capacity and failure isolation

**Files:**

- Create: `tests/load/ai-platform-v2-mixed.js`
- Create: `tests/integration/ai-platform-v2-chaos.test.ts`
- Create: `docs/runbooks/ai-platform-v2-soak.md`
- Modify: `src/server/services/workerTierTelemetry.ts`

**Interfaces:**

- Produces: repeatable evidence for release and retirement gates

- [ ] Run 30 Design Docs and 10 PRDs with document concurrency 12.
- [ ] Run visual generation at its currently approved Bedrock cap.
- [ ] Run fast and agentic interactive traffic together.
- [ ] Queue overflow beyond active capacity.
- [ ] Restart App Service.
- [ ] Kill one orchestrator replica.
- [ ] Kill workers before and after claim.
- [ ] Inject Blob 503 and Service Bus throttling.
- [ ] Trigger Redis failover at 24-turn surge.
- [ ] Interrupt WebSocket and checkpoint consumers.
- [ ] Simulate ARM unavailability.
- [ ] Inject a poison message and verify user-visible terminal failure.
- [ ] Pause a lease holder beyond expiry and verify fencing.
- [ ] Resume Home, Interview, and ADR threads after 30 minutes idle.
- [ ] Verify control-plane QPS no greater than 5.
- [ ] Verify batch incremental QPS no greater than 10 over baseline.
- [ ] Verify PostgreSQL CPU, latency, connections, and pool gates.
- [ ] Run a 48-hour soak with leak and queue-age monitoring.
- [ ] Preserve all rollback resources until the soak passes.

---



### Task 10: Retire legacy resources

**Files:**

- Modify with separate approval: `src/server/index.ts`
- Modify: legacy watcher/reaper/callback services
- Modify with separate approval: `infra/main.tf`
- Modify with separate approval: `infra/README.md`
- Modify with separate approval: `.github/workflows/deploy.yml`

- [ ] Confirm zero non-terminal v1 runs.
- [ ] Confirm no V2 rollback during the soak and observation window.
- [ ] Disable legacy callback routing.
- [ ] Remove App Service AI execution and watchers.
- [ ] Remove Azure Files as AI output handoff.
- [ ] Remove old Jobs and interactive app.
- [ ] Remove old Redis only after the replacement passes failover testing.
- [ ] Remove old environments after traffic remains zero.
- [ ] Delete stale database only under its separately approved decommission
  runbook.
- [ ] Run post-removal smoke and rollback-readiness checks.

---



## Delivery and approval model

Every child plan follows:

1. User approves exact files.
2. Write failing tests.
3. Run the focused test and confirm the expected failure.
4. Implement the minimum change.
5. Run focused tests.
6. Run type-check/build or Terraform fmt/validate as applicable.
7. Review the diff for scope and secrets.
8. Commit one independently reviewable unit.
9. Open a focused pull request.
10. Deploy to staging.
11. Run its failure and rollback tests.
12. Capture production Terraform plan.
13. Obtain a separate apply/deploy approval.
14. Canary before expansion.

No workstream combines an irreversible resource deletion with a new runtime
cutover.

## Deferred program ops (end of code track)

Parked until Tasks 5–8 (and related app wiring) are coded, reviewed, pushed,
and running on **dev/staging**:

- [ ] **Azure apply — AI Platform V2 foundation** (Task 4 Terraform only
  created resources behind `enable_ai_platform_v2`). Follow the deferred
  checklist under Task 4 above. Staging apply first; production apply only
  with a second approval. Do not stop or delete V1 in this pass.
- [ ] **Orchestrator hosting and CI wiring** (Task 5 shipped the process and
  its Dockerfile/publish script only). Needs a Container App resource, a
  registry repository, `deploy.yml` wiring, the environment variables listed
  under Task 5, and the execution probe closed before the process consumes
  real queues.
- [ ] **Task 2 rollout gates** (still open): staging/prod heartbeat swap
  verification; 25-document V1 regression before any capacity increase.
- [ ] **V1 retirement** (Task 8): only after V2 is proven in production —
  stop old resources → observation window → delete under a separate runbook.

## Cost gates

R0 replaces planning estimates with contracted prices. Approval must cover:

- New Central US Service Bus/storage if the single-region V2 decision selects
them
- Two warm orchestrator replicas
- Document and visual Job execution
- Four total warm interactive replicas, plus surge usage
- Redis replacement or larger SKU
- Temporary old/new environment overlap
- PostgreSQL D4 and HA, if measurement still justifies them
- Private endpoints and network egress
- Log Analytics ingestion and retention

Premium Service Bus and Premium ACR remain out of scope unless separately
approved.

## Program completion criteria

- App Service runs no AI/background execution.
- Workers hold no PostgreSQL connections.
- Every accepted run has durable command and result state.
- Completed artifacts survive App Service and orchestrator outages.
- Missed checkpoints do not falsely kill healthy workers.
- 40-document load stays inside database gates.
- Interactive failures preserve the same thread and user message.
- Visual concurrency is provider-proven.
- Zone and region claims match live resources.
- Full mixed test and 48-hour soak pass before legacy retirement.
- Final Terraform plan contains no unexplained replacement or destroy.
