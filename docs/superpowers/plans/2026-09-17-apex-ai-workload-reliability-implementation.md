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
