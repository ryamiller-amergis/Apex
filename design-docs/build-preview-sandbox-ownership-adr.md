---
adr-number: ADR-pending
status: Accepted
date: 2026-11-05
slug: build-preview-sandbox-ownership
approved-by: Phase 2 product owner
approval-source: Cursor session approval on 2026-11-05
---

# Build Preview Sandbox Ownership

## Status

Accepted for the Phase 2 pilot.

## Context

Build from Prompt must run generated full-stack applications before a user can accept them. Generated code is not trusted platform code. A preview needs compute isolation, a synthetic database, routing, authorization, quotas, expiration, cleanup, browser verification, and cost controls.

Phase 1 stores a static web bundle in Apex and grants one 24-hour preview lease per project/repository. That model cannot run the Express API or PostgreSQL and serializes unrelated revisions.

The ownership decision must avoid copying cloud infrastructure and credentials into every generated repository while allowing an application to declare how it builds and runs.

## Decision Drivers

- Keep generated code and credentials outside the Apex web/API process.
- Apply one security, cleanup, routing, and quota fix to every generated application.
- Preserve provider portability and local development.
- Give each build revision an immutable, independently disposable runtime.
- Support higher-isolation project tiers without making them the default.

## Considered Options

### Put preview infrastructure in each generated repository

Each repository would own its sandbox Terraform, credentials, routing, and cleanup. This duplicates platform code, gives generated repositories infrastructure responsibilities, and creates drift. Rejected.

### Provision a complete sandbox platform per Apex project

This increases isolation but adds slow provisioning, quota fragmentation, and operational cost. Retained only as a future high-sensitivity tier.

### Use an Apex-owned shared control plane

Apex owns desired state, authorization, quotas, routing, lifecycle, browser verification, and cleanup. Platform Engineering owns shared Azure resources. Generated applications own only a versioned runtime contract. Chosen.

## Decision Outcome

Chosen option: **Apex-owned shared preview control plane with one isolated runtime per build revision**.

- Apex project is the administrative tenant.
- Build revision is the runtime isolation unit.
- Requesting user is a quota and authorization subject.
- Every revision receives its own artifact digest, sandbox handle, database and role, gateway mapping, expiry, and browser evidence.
- A running sandbox is never reused by another revision.
- Project configuration selects quotas, egress, region, and optional isolation tier; it does not provision infrastructure from the generated repository.
- The generated repository declares build, migrate, preview-seed, start, health, port, identity, and Playwright commands in a versioned manifest.

Pilot operating defaults:

- Maximum 2 active sessions per requester, 4 per project, and 8 platform-wide.
- Maximum 4 sessions provisioning at once.
- One temporary overlap is allowed while a verified replacement revision is being prepared.
- Readiness P95 target is 90 seconds; hard provisioning timeout is 180 seconds.
- Preview-request-to-published-browser-proof P95 target is 150 seconds.
- Idle TTL is 30 minutes; absolute TTL is 8 hours.
- A superseded revision receives a 5-minute grace period; cleanup must finish within 10 minutes.
- The pilot runs in one region colocated with Apex, Blob storage, the gateway, and preview PostgreSQL.
- Preview sessions are recreated after a regional failure; they are not failed over live.

These limits are pilot admission defaults, not permanent product limits. Re-baseline them after utilization, latency, and cost data exists.

Measurement definitions:

- Readiness latency starts when Apex accepts the preview-instance request and ends when the matching artifact digest, database migration, seed, process startup, and readiness probe have all passed.
- Published browser-proof latency uses the same start and ends when the required browser check passes and the gateway alias is published.
- A request that reaches the 180-second hard timeout is an SLO miss. User cancellation is excluded. Application-contract failures and provider/infrastructure failures are reported separately but both remain visible in the user-level success rate.
- Report pilot percentiles only after at least 30 eligible attempts. Use a rolling 14-day window once traffic supplies at least 30 attempts; otherwise report raw samples without claiming an SLO.
- Run a fixed Golden Stack reference workload alongside real builds so provider regressions can be separated from application-specific failures.
- Cleanup latency is measured separately from readiness, from terminal/superseded intent until compute, route, database, role, and credential are confirmed absent.

## Consequences

### Positive

- Generated repositories contain no preview-platform Terraform or provider credentials.
- One provider or security improvement applies to all generated applications.
- Multiple revisions can run concurrently within quotas.
- Local Docker and Azure providers can share one lifecycle contract.
- Cleanup and cost controls have one durable owner.

### Negative

- Apex becomes responsible for a new shared control plane and reconciler.
- Provider and regional outages affect multiple projects.
- Higher-sensitivity projects may require dedicated stamps later.
- Pilot quotas are conservative until production measurements exist.

## References

- `src/server/services/buildPreviewLeaseService.ts`
- `src/shared/types/build.ts`
- `templates/full-stack-express/Dockerfile`
- `design-docs/build-from-prompt-phase-2.plan.md`
- https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview
- https://learn.microsoft.com/en-us/azure/container-apps/sessions
