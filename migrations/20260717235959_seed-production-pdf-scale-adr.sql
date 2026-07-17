-- Seed the accepted PDF Assembly scale ADR after the ADR schema migrations.
-- Thread runtime fields are intentionally sanitized because local agent/workspace
-- identifiers are not valid in production.

INSERT INTO app_users (oid, display_name, email)
VALUES (
  '110b196f-3f0d-4890-969f-5571085039de',
  'Ryan Miller',
  'ryamiller@amergis.com'
)
ON CONFLICT (oid) DO NOTHING;

INSERT INTO chat_threads (
  id,
  user_id,
  status,
  kickoff,
  cursor_agent_id,
  workspace_dir,
  last_error,
  saved_wiki_url,
  title,
  flagged,
  flagged_at,
  active_run_id,
  created_at,
  last_activity_at
)
VALUES (
  'f68c90fe-70b1-40cf-b5bb-416419adacbe',
  '110b196f-3f0d-4890-969f-5571085039de',
  'closed',
  '{
    "repo": "Apex",
    "model": "grok-4.5",
    "branch": "feat/adr",
    "project": "Apex",
    "skillPath": "/.cursor/skills/adr-interview/SKILL.md",
    "skillProvider": "github",
    "skillSettingsId": "df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73"
  }'::jsonb,
  NULL,
  NULL,
  NULL,
  NULL,
  'Adr Interview - Scale PDF Assembly to ~2000 Concurrent Sessions',
  FALSE,
  NULL,
  NULL,
  '2026-07-16T13:10:35.903Z',
  '2026-07-16T13:22:01.702Z'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO adrs (
  id,
  chat_thread_id,
  adr_assistant_thread_id,
  author_id,
  reviewer_ids,
  title,
  project,
  repo,
  model,
  skill_settings_id,
  status,
  content,
  proposed_content,
  fix_comment_id,
  slug,
  created_at,
  updated_at
)
VALUES (
  '2116a2f2-b52d-4590-ad91-ba3f7d67f545',
  'f68c90fe-70b1-40cf-b5bb-416419adacbe',
  NULL,
  '110b196f-3f0d-4890-969f-5571085039de',
  NULL,
  'mass users using pdf tool',
  'Apex',
  'Apex',
  'grok-4.5',
  (
    SELECT id
    FROM project_skill_settings
    WHERE id = 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73'
    LIMIT 1
  ),
  'accepted',
  $production_adr$
---
adr-number: ADR-pending
status: Accepted
date: 2026-07-16
slug: scale-pdf-assembly-2000-concurrent-sessions
---

# Scale PDF Assembly to ~2000 Concurrent Sessions

## Status

Accepted

## Context

Apex PDF Tools (`/pdf-tools`) must support roughly **2000 concurrent sessions** using assembly and related heavy paths (upload/parse, DOCX conversion, assemble/export). Today, assembly uses a three-panel UX with client-side `pageManifest` and server routes around `pdf_sessions`. Per-user caps already exist (3 active sessions/user, 100 MB/file, 250 MB/session, 500 pages/session). Export runs via ad-hoc `worker_threads` (`pdfExportWorker`) with no global multi-instance governor; DOCX conversion already uses a DB-backed job queue with claim/heartbeat (`pdfConversionJobService` / `pdfConversionJobs`). Session artifacts live on local disk (`PDF_TEMP_DIR`), which breaks cross-instance job claim on Azure App Service scale-out.

**In scope:** global concurrency, export/conversion queues, per-user and system limits, and worker model for heavy PDF work.

**Out of scope:** UX layout changes, new assembly product features, and auth/RBAC changes. Exact Azure SKU names and instance counts are not locked here; they are set via an infra capacity gate validated by load tests.

**Capacity model:** size for ~2000 concurrent sessions; run all heavy work through one shared queue/worker pool with a concurrent-job ceiling in the tens–low hundreds and explicit back-pressure when saturated — not provision for 2000 simultaneous CPU-heavy jobs.

**Constraints:** capacity and reliability for this load outweigh minimizing infrastructure. Soft MVP latency targets (`uploadAndParseMs: 10s` for 50 pages; `assembleAndExportMs: 15s` for 100 pages) remain goals, not reasons to under-build. Work is still in development/testing, so production feature-flag dual-path migration is not required.

## Decision Drivers

- Support ~2000 concurrent PDF Tools sessions without crashing the API under peak load
- Scale every heavy path (conversion, export/assembly, heavy ingest/parse), not only one feature
- Prefer stronger job-delivery semantics and isolation from the application database for the heavy-work queue at this scale
- Keep interactive session/manifest APIs responsive by moving CPU/memory-heavy work off the request path
- Fairness under contention (per-user caps) and clear back-pressure (queue status, then 429 on overflow/age)
- Multi-instance App Service compatibility via shared artifact storage
- Pre-prod delivery with load-test validation and observability as release gates
- Protect sensitive PDF content in blob storage (private access, short-lived user-scoped URLs)
- Prove infra capacity (workers, API, broker, Postgres metadata, blob) under the capacity model before calling scale-ready — without locking exact SKUs in this ADR

## Considered Options

### Option A — Production-grade Postgres unified job queue + dedicated workers + Azure Blob

Extend the existing conversion lease/heartbeat pattern into a **unified Postgres PDF job queue** covering conversion, export/assembly, and threshold-based heavy ingest/parse. Use **atomic claim** (`FOR UPDATE SKIP LOCKED` or equivalent), reliable lock renewal, idempotent handlers, and a stale-job reaper. Store all session/job artifacts in **private Azure Blob** (or equivalent). Run a **dedicated PDF worker pool** separate from the API. Cap concurrency at **global ~75** and **per-user 3** heavy jobs (keep **3 sessions/user**); queue with status visibility; return **429** only when wait ≳2 minutes or queue depth exceeds a configured max.

Benefits: reuses repo patterns; works across App Service instances; protects API latency; fair back-pressure; no new broker dependency.

Costs/risks: Postgres becomes the queue backbone (indexing, reaping, depth alerts, DIY claim/renewal correctness); blob I/O latency vs local disk; more ops surface for worker scale/health; current conversion implementation is not sufficient as-is (60s stale reclaim vs long jobs; local-disk affinity).

### Option B — Managed broker (e.g. Azure Service Bus / Redis) + dedicated PDF workers + Azure Blob (chosen)

Use a **managed broker** for conversion, export/assembly, and threshold-based heavy ingest/parse. Persist job metadata and status for UI visibility, fairness, idempotency, and audit in Postgres without using Postgres as the primary delivery mechanism. Store all session/job artifacts in **private Azure Blob**. Run a **dedicated PDF worker pool** separate from the API that receives and completes broker messages. Cap concurrency at **global ~75** and **per-user 3** heavy jobs (keep **3 sessions/user**); queue with status visibility; return **429** only when wait ≳2 minutes or queue depth exceeds a configured max.

Benefits: stronger delivery and lock-renewal semantics with less DIY claim risk; clearer isolation of heavy-job traffic from the application database; supports dedicated workers, shared blob, fairness caps, and back-pressure.

Costs/risks: new infrastructure and operations model (broker namespaces, queues/topics, credentials, DLQ); shared blob is still required; higher platform cost and complexity than extending Postgres alone; migration is required from today’s `pdfConversionJobs` lease path and in-process export workers.

### Option C — Stay in-process on API nodes (`worker_threads` + process-local caps only)

Keep export on ad-hoc `worker_threads` and rely on per-process concurrency caps without a global queue or dedicated workers.

Benefits: simplest change set; no new storage or worker deployment.

Costs/risks: weakest under multi-instance 2000-session load; no global fairness/governor; API nodes remain exposed to CPU/memory spikes; local disk affinity remains.

## Decision Outcome

Chosen option: **Option B — Managed broker + dedicated PDF workers + Azure Blob**

This best satisfies the drivers at ~2000 concurrent sessions when capacity and reliability outweigh minimizing infrastructure: a managed broker provides production-grade job ownership (peek-lock + renewal, dead-lettering) without making Postgres the hot-path queue backbone, while dedicated workers and private blob move CPU-heavy work off the API and enable multi-instance processing. Option A remains a valid simpler fallback if broker cost/operations prove unnecessary after load testing; in-process-only (Option C) does not meet the capacity model.

**Preferred broker (initial):** Azure Service Bus (queues; peek-lock + lock renewal; dead-letter queue). Redis/BullMQ-class brokers remain acceptable equivalents if operations standardizes on them — the ADR locks the **managed-broker ownership model**, not a forever-immutable product SKU.

**Architecture locked by this ADR:**

| Concern | Decision |
| --- | --- |
| Sessions | ~2000 concurrent PDF Tools sessions |
| Heavy-job delivery | Managed broker (prefer Azure Service Bus); peek-lock + renewal; DLQ for poison messages |
| Job metadata | Postgres stores status, identity, idempotency keys, per-user counters, visibility, and audit — not the primary claim loop |
| Heavy jobs | Unified async pipeline; initial global ~75 / per-user 3 concurrent jobs |
| Sessions/user | Keep 3 active sessions/user |
| Back-pressure | Queue with status; 429 if wait ≳2 min or depth exceeds max |
| Queued work | Conversion, export/assembly, heavy ingest/parse (threshold-based) |
| Sync APIs | Session CRUD and manifest patches remain synchronous |
| Storage | Private Azure Blob for all PDF session/job artifacts |
| Blob access | Managed identity for services; short-lived user-scoped download URLs after authorization |
| Workers | Dedicated pool separate from API; receive/complete broker messages; renew locks for long jobs |
| Delivery | Direct milestone build; load tests; no feature flag |
| Observability | Metrics and alerts on broker depth/age, lock-renewal failures, DLQ growth, worker saturation, blob I/O errors, 429 rate, and per-job success/latency |
| Required mitigations | Idempotent handlers, lock renewal, migration off the 60-second Postgres stale-reclaim path, shared blob, DLQ and poison handling |
| Infra capacity gate | Workers, API, broker, Postgres metadata, and blob must be sized and validated under load before scale-ready |

**Technical specification (Option B):**

1. **Enqueue path:** Authenticated session APIs accept heavy-work requests, enforce per-user session/job caps, persist a queued job row with an idempotency key, then send a broker message referencing `jobId`, `sessionId`, and job type. Return the job id and status URL; do not run PDF CPU work on the request thread.
2. **Ownership:** Workers receive messages with peek-lock or equivalent. Lock duration and renewal must cover long jobs. Complete on success; abandon/retry with bounded attempts; dead-letter after maximum delivery with an alert.
3. **Concurrency governor:** Enforce an application-level global ~75 and per-user 3 active processing slots so broker fan-out cannot exceed the capacity model. Worker prefetch and concurrency must respect the global ceiling.
4. **Back-pressure:** Expose queue position/status from job metadata. If estimated wait is ≳2 minutes or depth exceeds the configured maximum, reject new heavy jobs with **429** while session and manifest APIs remain available.
5. **Artifacts:** Store all inputs and outputs in private Azure Blob. Workers read/write through managed identity; clients receive short-lived user-scoped URLs only after authorization. Do not rely on `PDF_TEMP_DIR` for cross-instance jobs.
6. **Idempotency:** Handlers must be safe under at-least-once delivery, deduplicating on `jobId` or idempotency key with sticky terminal states.
7. **Migration from today:** Replace ad-hoc `pdfExportWorker` `worker_threads` and the DIY `pdfConversionJobs` 60-second stale-reclaim loop with broker-backed delivery for all queued heavy paths.
8. **Infra capacity gate:** Prove workers (~75 concurrent jobs), API (~2000 sessions of synchronous traffic), broker throughput/depth, Postgres metadata load, and blob I/O under soak tests before scale-ready.

**Infra capacity gate:**

| Component | What must be proven | Notes |
| --- | --- | --- |
| Dedicated PDF workers | Sustain ~75 concurrent heavy jobs without sustained CPU/memory saturation or lock-renewal failure | Net-new worker plan/role is expected |
| API App Service | Handle ~2000 concurrent sessions for synchronous session/manifest traffic with heavy work off-box | Scale from measured RPS and connection data |
| Managed broker | Keep depth, lock renewal, and DLQ behavior healthy at peak enqueue/processing rates | Size namespace/SKU from load tests |
| Postgres | Keep metadata, cap, and status writes healthy under API and worker concurrency | Not the primary queue |
| Azure Blob | Meet upload/download throughput and latency targets for session/job artifacts | Validate bandwidth and access model |

Final SKUs, vCores, and instance counts are selected from load-test results and operations practice; this ADR locks the gate and capacity ownership, not a specific catalog SKU.

## Consequences

### Positive

- Interactive API traffic remains responsive because CPU-heavy PDF work runs on dedicated workers
- All heavy paths share one fairness and back-pressure model
- Multi-instance App Service scale-out works because any worker can process any job against shared blob artifacts
- Managed broker supplies production ownership semantics with less DIY claim/reaper risk than a Postgres hot-path queue
- Heavy-job delivery load is isolated from the application database
- Explicit initial caps, observability gates, and an infrastructure capacity gate make tuning evidence-based

### Required mitigations

These are not acceptable residual risks for a production-ready ~2000-session deployment:

- **Broker ownership correctness:** peek-lock with renewal for the full job duration, bounded retries, dead-letter handling, and alerts
- **Idempotent handlers and sticky terminal state:** at-least-once delivery must not duplicate side effects
- **Shared private blob for all artifacts:** eliminate local-disk affinity
- **Application-level concurrency governor:** enforce global ~75 / per-user 3 in application coordination and worker prefetch
- **Migration off in-process export and DIY conversion claim:** replace current worker-thread and stale-reclaim paths
- **Infrastructure capacity gate:** provision and prove workers, API, broker, Postgres metadata, and blob capacity before scale-ready

### Accepted trade-offs

- New managed-broker dependency and operational surface
- Blob migration adds I/O latency and implementation cost
- Dedicated workers add deployment and scaling complexity
- The ~75 heavy-job ceiling means users may queue or receive 429 under extreme spikes
- Soft MVP latency targets may not hold under saturated queues
- Infrastructure cost rises through broker, workers, and likely API/Postgres headroom
- Dual persistence of broker messages and Postgres job metadata adds implementation complexity

## References

- Kickoff and interview decisions recorded in `.ai-pilot/kickoff-transcript.md`
- PDF Tools assembly surface: `/pdf-tools`
- Existing services: `pdfAssemblyService`, `pdfExportWorker`, `pdfConversionJobService`, and `pdfConversionJobs`
- Soft MVP timing targets: `uploadAndParseMs` (10 seconds / 50 pages), `assembleAndExportMs` (15 seconds / 100 pages)
- Runtime context: Azure App Service multi-instance hosting and local temp paths through `PDF_TEMP_DIR`
- Related timeout: `DOCX_CONVERSION_TIMEOUT_MS` (default 15 minutes) versus the 60-second stale-reclaim gap
$production_adr$,
  NULL,
  NULL,
  'scale-pdf-assembly-2000-concurrent-sessions',
  '2026-07-16T13:10:36.052Z',
  '2026-07-17T14:17:59.956Z'
)
ON CONFLICT (id) DO NOTHING;
