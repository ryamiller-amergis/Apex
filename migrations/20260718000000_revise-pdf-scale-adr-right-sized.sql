-- Revise the accepted PDF Assembly scale ADR to the corrected (right-sized)
-- capacity model: ~2000 concurrent light app users but only ~20 concurrent
-- PDF-assembly users / single-digit simultaneous CPU jobs. This supersedes the
-- managed-broker + dedicated-worker decision with an in-app async + Postgres
-- queue + private Blob + App Service autoscale approach.
--
-- The prior content was seeded by 20260717235959_seed-production-pdf-scale-adr.
-- We UPDATE the same row (idempotent) rather than editing that historical file.

UPDATE adrs
SET
  content = $revised_adr$
---
adr-number: ADR-pending
status: Accepted
date: 2026-07-17
slug: scale-pdf-assembly-2000-concurrent-sessions
---

# Scale PDF Assembly for Concurrent Use (Right-Sized Capacity Model)

## Status

Accepted — revised 2026-07-17. Supersedes the original "~2000 concurrent heavy sessions" decision (managed broker + dedicated worker pool) after the real load profile was clarified.

## Context

Apex PDF Tools (`/pdf-tools`) supports assembly and related heavy paths (upload/parse, DOCX conversion, assemble/export). Assembly uses a three-panel UX with client-side `pageManifest` and server routes around `pdf_sessions`. Per-user caps already exist (3 active sessions/user, 100 MB/file, 250 MB/session, 500 pages/session). Export runs via ad-hoc `worker_threads` (`pdfExportWorker`); DOCX conversion uses a DB-backed job queue with claim/heartbeat (`pdfConversionJobService` / `pdfConversionJobs`) built on `@matbee/libreoffice-converter` (LibreOffice compiled to WASM, run in-process). Session artifacts live on local disk (`PDF_TEMP_DIR`).

**Corrected capacity model:** the platform serves roughly **2000 concurrent app users** doing normal, light interactive work. PDF assembly is a small slice: expect **~20 concurrent PDF-assembly users at peak** and **single-digit simultaneous CPU-heavy jobs** (conversion/export). This is one to two orders of magnitude smaller than the original "2000 concurrent heavy sessions / ~75 simultaneous jobs" assumption that drove the prior decision.

**Production runtime (verified):** the API runs on `plan-apex-prd-v2` — P1v3 (PremiumV3), **zone-redundant across 3 instances**. Autoscale is now added (min 3 for zone redundancy, scale out to 6 on sustained CPU). Because the API is multi-instance, PDF work cannot depend on `PDF_TEMP_DIR` local-disk affinity.

**In scope:** concurrency governor, artifact storage, long-job ownership correctness, and the worker execution model for heavy PDF work at the real load.

**Out of scope:** UX layout changes, new assembly features, and auth/RBAC changes.

## Decision Drivers

- Serve ~2000 concurrent light app users without heavy PDF work degrading interactive latency
- Handle the actual heavy concurrency (~20 users, single-digit simultaneous CPU jobs) without over-provisioning infrastructure
- Multi-instance App Service correctness: any instance (including autoscaled instances) can process any session's artifacts
- Fix long-job ownership: DOCX conversion can run up to `DOCX_CONVERSION_TIMEOUT_MS` (15 min) while today's stale reclaim is ~60 s
- Protect sensitive PDF content (private blob, short-lived user-scoped URLs)
- Prefer reusing existing repo patterns over adding new infrastructure dependencies and operational surface
- Keep a documented, evidence-gated path to scale up if real usage exceeds these estimates

## Considered Options

### Option A′ — Postgres job queue + in-app capped workers + private Blob + App Service autoscale (chosen)

Extend the existing Postgres conversion queue to cover export/assembly. Process heavy work **in-process on the Apex App Service** off the request thread (`worker_threads`), bounded by a strict application concurrency governor (global ~20, per-user 3). Fix job ownership with lock renewal covering the full job duration and retire the ~60 s stale-reclaim path. Store all session/job artifacts in **private Azure Blob** keyed per `{userId}/{sessionId}/...` via managed identity, eliminating `PDF_TEMP_DIR` affinity. Add **App Service autoscale** (min 3 for zone redundancy, scale out on CPU) so heavy spikes get compute headroom without a separate worker tier.

Benefits: reuses repo patterns; no new broker/worker deployment or ops surface; multi-instance correct via shared blob; autoscale absorbs spikes; fits the real load.

Costs/risks: heavy CPU (LibreOffice-WASM) still shares App Service compute with the API — mitigated by the concurrency cap and autoscale; Postgres remains the queue backbone (indexing, reaping, depth alerts); blob I/O latency vs local disk.

### Option B — Managed broker (Azure Service Bus) + dedicated PDF worker pool + Blob (deferred)

The original decision: managed-broker delivery (peek-lock + renewal, DLQ) with a dedicated worker App Service separate from the API, sized for ~75 concurrent jobs.

Why deferred: correct for ~2000 concurrent heavy sessions, but that load does not exist. At ~20 concurrent users / single-digit jobs the broker and dedicated worker plan add cost, deployment, and operational surface with no payoff. Kept as the **scale-up path** behind explicit triggers (below).

### Option C — Stay in-process with process-local caps only (rejected)

Keep ad-hoc `worker_threads` with per-process caps, no global governor, no shared storage. Rejected: no cross-instance fairness and breaks on multi-instance local-disk affinity — already a correctness bug on the 3-instance production plan.

## Decision Outcome

Chosen option: **Option A′ — Postgres queue + in-app capped workers + private Blob + App Service autoscale.**

This satisfies the corrected drivers with the least infrastructure: interactive traffic stays responsive via an enforced concurrency governor and autoscale headroom; heavy jobs are multi-instance-correct because artifacts live in shared blob and ownership survives long jobs; and no new broker/worker ops surface is introduced for a load that does not require it.

**Architecture locked by this ADR:**

| Concern | Decision |
| --- | --- |
| Load profile | ~2000 concurrent light app users; ~20 concurrent PDF-assembly users; single-digit simultaneous CPU jobs |
| Heavy-job delivery | Existing Postgres job queue extended to conversion + export/assembly; atomic claim (`FOR UPDATE SKIP LOCKED`) |
| Worker execution | In-process on the Apex App Service (`worker_threads`) off the request thread — no dedicated worker plan |
| Concurrency governor | Application-enforced global ~20 and per-user 3 concurrent heavy jobs; keep 3 sessions/user |
| Long-job ownership | Lock/lease renewal covering full job duration; retire the ~60 s stale-reclaim path |
| Storage | Private Azure Blob for all PDF session/job artifacts, keyed `{userId}/{sessionId}/...`; no `PDF_TEMP_DIR` cross-instance reliance |
| Blob access | Managed identity for the app; short-lived user-scoped download URLs after authorization |
| Compute scaling | App Service autoscale (min 3 for zone redundancy, scale out to 6 on sustained CPU) |
| Back-pressure | Queue with status; reject new heavy jobs with 429 when the governor is saturated or estimated wait is excessive |
| Sync APIs | Session CRUD and manifest patches remain synchronous |
| Managed broker + dedicated workers | Deferred (Option B) behind explicit scale triggers |
| Observability | Metrics/alerts on queue depth/age, lock-renewal failures, job success/latency by type, App Service CPU + instance count, 429 rate, blob I/O errors |

**Scale-up triggers (revisit Option B) — adopt a managed broker and/or a dedicated worker plan when any hold under real load:**

- Sustained App Service CPU saturation from PDF work despite autoscale to max, harming interactive latency
- Concurrent heavy-job demand consistently approaching or exceeding ~20 (governor rejecting frequently)
- Postgres queue contention or reaper/lock-renewal correctness proving hard to keep healthy
- A need to deploy/scale PDF workers independently of the API release cadence

## Consequences

### Positive

- Minimal new infrastructure: reuses the Postgres queue and the existing App Service; only Blob + autoscale are added
- Multi-instance correct: shared blob artifacts work across the 3 zone-redundant instances and any autoscaled instance
- Autoscale gives real CPU headroom for heavy spikes without a standing dedicated worker tier
- Long-job ownership fix removes the ~60 s vs 15 min defect class
- Clear, evidence-gated path to the managed-broker/dedicated-worker design if usage grows

### Accepted trade-offs

- Heavy CPU (LibreOffice-WASM) shares App Service compute with the API — bounded by the concurrency governor and autoscale; validated by monitoring CPU and 429 rate
- Postgres remains the queue backbone (indexing, reaping, depth alerts) rather than a managed broker
- Blob I/O adds latency vs local disk for uploads, conversion inputs, and export outputs — accepted cost of multi-instance correctness
- Under extreme simultaneous spikes users may queue or receive 429 — accepted vs provisioning dedicated heavy-job infrastructure for a load that is not expected

### Required mitigations (must ship with this work)

- **Shared private blob for all artifacts** keyed per user/session — eliminate `PDF_TEMP_DIR` affinity
- **Concurrency governor** (global ~20 / per-user 3) enforced in application coordination
- **Long-job lock/lease renewal** covering `DOCX_CONVERSION_TIMEOUT_MS`-class durations; retire the ~60 s stale reclaim
- **Idempotent handlers** safe under retry, with sticky terminal states
- **Back-pressure** (queue status + 429 on saturation) so heavy work never blocks session/manifest APIs

## References

- Original decision: seeded by migration `20260717235959_seed-production-pdf-scale-adr`; revised here after the corrected capacity model
- PDF Tools assembly surface: `/pdf-tools`
- Existing services: `pdfAssemblyService`, `pdfExportWorker`, `pdfConversionJobService`, `pdfConversionJobs`
- Conversion runtime: `@matbee/libreoffice-converter` (LibreOffice WASM, in-process `worker_threads`)
- Production plan: `plan-apex-prd-v2` (P1v3, zone-redundant, 3 instances, autoscale 3–6 on CPU)
- Infra: `infra/shared-async.tf` (Blob `pdf-artifacts`), `infra/pdf-processing.tf` (Apex identity Blob RBAC), `infra/main.tf` (autoscale)
- Related timeout: `DOCX_CONVERSION_TIMEOUT_MS` (default 15 minutes) versus the ~60-second stale-reclaim gap
$revised_adr$,
  updated_at = NOW()
WHERE id = '2116a2f2-b52d-4590-ad91-ba3f7d67f545';
