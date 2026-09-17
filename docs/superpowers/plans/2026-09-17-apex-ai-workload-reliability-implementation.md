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
- Production has the 600,000 ms heartbeat mitigation; staging and GitHub do not.
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
- [ ] Confirm the next production deployment passes the hostname guard.
- [ ] Remove the old server only after state no longer owns it, connections are
  explained, a backup is retained, and the user separately approves deletion.

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

**Files:**

- Modify: `src/server/services/designDocService.ts`
- Modify: `src/server/services/startupRecovery.ts`
- Modify: `src/server/services/agentRunReaperService.ts`
- Modify: `src/server/services/serviceBusPublisher.ts`
- Modify: `src/server/routes/api.ts`
- Modify with separate approval: `src/server/index.ts`
- Modify: `src/server/db/schema.ts`
- Create: `migrations/<timestamp>_agent-run-control-plane-indexes.sql`
- Modify with separate approval: `.github/workflows/deploy.yml`
- Modify with separate approval: `infra/main.tf`
- Modify with separate approval: `.env.example`
- Test: `src/server/__tests__/designDocService.test.ts`
- Test: `src/server/__tests__/startupRecovery.test.ts`
- Test: `src/server/__tests__/agentRunReaperService.test.ts`
- Test: `src/server/__tests__/serviceBusPublisher.test.ts`
- Test: `src/server/__tests__/healthDb.test.ts`

**Interfaces:**

- Consumes: current v1 worker and watcher behavior
- Produces: bounded v1 behavior safe enough to operate during V2 delivery

- [ ] Write failing tests proving one logical watcher owner across instances.
- [ ] Replace overlapping async watcher ticks with completion-scheduled ticks.
- [ ] Add a top-level watcher error boundary and database-failure backoff.
- [ ] Collapse repeated run-state reads into one snapshot query.
- [ ] Add the latest-run-by-thread and transient-document indexes.
- [ ] Leader-elect recovery and reaper sweeps.
- [ ] Bound sweeps by due time and batch size.
- [ ] Make `/api/health/live` process-only.
- [ ] Keep bounded database readiness separate from external-dependency health.
- [ ] Rebuild the Service Bus publish request and token per retry.
- [ ] On one 401/403, invalidate the credential once before durable recovery
  takes over.
- [ ] Change the code heartbeat fallback from 90,000 to 600,000 ms.
- [ ] Add `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS=600000` to both slot deployment
  contracts.
- [ ] Mark the heartbeat setting sticky.
- [ ] Verify staging and production retain the same value through a swap test.
- [ ] Run the isolated watcher/reaper/publisher/health suites.
- [ ] Run a 25-document v1 regression test before increasing any capacity.

---



### Task 3: Add durable run protocol tables and contracts

**Files:**

- Modify: `src/server/db/schema.ts`
- Create: `migrations/<timestamp>_ai-run-v2-control-plane.sql`
- Create: `src/shared/types/aiRunV2.ts`
- Create: `src/server/services/aiRunV2/outboxRepository.ts`
- Create: `src/server/services/aiRunV2/inboxRepository.ts`
- Create: `src/server/services/aiRunV2/distributedLeaseRepository.ts`
- Create: `src/server/services/aiRunV2/runAttemptRepository.ts`
- Create: `src/server/services/aiRunV2/artifactManifest.ts`
- Test: `tests/integration/ai-run-v2-persistence.integration.test.ts`

**Interfaces:**

- Produces:
  - Transactional outbox rows
  - Idempotent inbox event claims
  - Permanent seeded lease rows with fencing tokens
  - Versioned run attempts
  - `http-files-v1` and `servicebus-blob-v2` transport markers
  - `checking_worker`, `finalizing`, and terminal failure categories

- [ ] Define exact V2 command, checkpoint, result, and manifest schemas.
- [ ] Add one-active-run-per-thread enforcement.
- [ ] Add permanent seeded leases for admission, recovery, reaper, and outbox.
- [ ] Enforce update-only lease acquisition/renewal for application roles.
- [ ] Keep acquisition and renewal as distinct atomic statements.
- [ ] Use PostgreSQL time and a non-resetting bigint fencing token.
- [ ] Add an abort signal for lost long-running leases.
- [ ] Add idempotent inbox event IDs and monotonic checkpoint sequences.
- [ ] Add attempt-scoped dispatch fences.
- [ ] Add artifact status distinct from execution status.
- [ ] Add integration tests for duplicates, stale fences, lease takeover, and
  split-brain behavior.

---



### Task 4: Provision the V2 Azure foundation

**Files:**

- Create: `infra/ai-platform-v2.tf`
- Create: `infra/ai-platform-v2-networking.tf`
- Create: `infra/ai-platform-v2-identities.tf`
- Create: `infra/ai-platform-v2-monitoring.tf`
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

- [ ] Decide, with explicit cost approval, whether V2 uses a new Central US
  Standard Service Bus namespace or intentionally retains East US messaging.
- [ ] Decide, with explicit migration approval, whether V2 AI artifacts use a
  new Central US storage account or intentionally retain East US storage.
- [ ] Create the V2 environment with zone redundancy enabled at creation.
- [ ] Add Consumption and repo-read workload profiles.
- [ ] Configure Log Analytics using resource-specific tables.
- [ ] Add private `ai-run-artifacts` storage with lifecycle rules.
- [ ] Create document, visual, fast, agentic, checkpoint, and result queues.
- [ ] Enable duplicate detection on commands and terminal results only.
- [ ] Keep sessions and checkpoint duplicate detection disabled.
- [ ] Add entity-scoped managed-identity role assignments.
- [ ] Keep public endpoints during the first functional smoke.
- [ ] Add private endpoints later as an independent, reversible phase.
- [ ] Add Terraform tests for immutable queue and environment properties.

---



### Task 5: Build the orchestrator

**Files:**

- Create: `src/server/services/aiOrchestrator/orchestrator.ts`
- Create: `src/server/services/aiOrchestrator/outboxDrainer.ts`
- Create: `src/server/services/aiOrchestrator/admissionController.ts`
- Create: `src/server/services/aiOrchestrator/checkpointConsumer.ts`
- Create: `src/server/services/aiOrchestrator/resultConsumer.ts`
- Create: `src/server/services/aiOrchestrator/reconciler.ts`
- Create: `src/server/services/aiOrchestrator/providerGovernor.ts`
- Create: `src/server/services/aiOrchestrator/entrypoint.ts`
- Create: `runners/ai-orchestrator/Dockerfile`
- Create: `scripts/ci/publish-ai-orchestrator.sh`
- Modify with separate approval: `.github/workflows/deploy.yml`
- Test: `src/server/__tests__/aiOrchestrator/*.test.ts`

**Interfaces:**

- Consumes: outbox, V2 queues, Blob manifests, provider/lane capacities
- Produces: dispatches, checkpoints, finalized runs/documents, alerts

- [ ] Wake the outbox drainer with PostgreSQL NOTIFY.
- [ ] Add a 30-second leased safety sweep.
- [ ] Claim bounded outbox batches with `SKIP LOCKED`.
- [ ] Enforce provider and lane floors with borrowable shared capacity.
- [ ] Start Cursor provider cap at 20 and Bedrock at 2.
- [ ] Batch checkpoint persistence.
- [ ] Keep checkpoint and terminal consumer pools separate.
- [ ] Move stale runs to `checking_worker` after missed checkpoints.
- [ ] Require positive Container Apps execution confirmation for
  `worker_lost`.
- [ ] Pause background dispatch at two uncertain workers.
- [ ] Finalize terminal results transactionally and idempotently.
- [ ] Dead-letter poison messages and terminalize the user-visible run.
- [ ] Emit control-plane QPS, queue age, lease, provider, and finalization
  metrics.

---



### Task 6: Build document and visual workers

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

- [ ] Receive commands with peek-lock.
- [ ] Publish a started checkpoint containing the Container Apps execution ID.
- [ ] Complete the command only after the fenced attempt is durably started.
- [ ] Publish checkpoints every 30 seconds.
- [ ] Use ephemeral local workspace and repo-read.
- [ ] Enforce normal and large phase deadlines.
- [ ] Upload files under attempt-scoped immutable Blob paths.
- [ ] Write the manifest last.
- [ ] Publish terminal result before process exit.
- [ ] Use a new attempt and dispatch ID after confirmed post-claim loss.
- [ ] Keep all PostgreSQL packages and connections out of worker entrypoints.
- [ ] Start visual concurrency at two and implement automatic rollback from
  three/four on Bedrock throttling.

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

