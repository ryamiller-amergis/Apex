---
adr-number: ADR-pending
status: Proposed
date: 2026-07-30
slug: grounded-checkout-interviews-blob-workspace
---

# Grounded-Checkout Interviews with Blob-Backed Workspace

## Status

Proposed

## Context

Interview and ADR chat turns hang, most often pinned on the GitHub `search_repo_code` MCP call (and its ADO equivalent). The failure surface is verified in code:

- `searchRepoCode` calls GitHub's live `/search/code` API — a ~10 req/min cap, a **global singleton** (`activeCodeSearch`) that rejects overlapping searches, and throttle/rate-limit branches (`src/server/services/skillCatalogGitHub.ts`).
- GitHub MCP handlers wrap calls in `raceWithTimeout` (~35s, `src/server/mcp/github/server.ts`), yet hangs last **minutes** because the Cursor SDK/MCP Streamable HTTP stream does not always observe tool completion (`.cursor/skills/hung-interview-troubleshoot/SKILL.md`, failure mode A).
- The ADO repo MCP tools are **not** wrapped in `raceWithTimeout`, so a stuck ADO call pins the turn until cancel/reaper.

Interviews run long (days) and today ground themselves entirely through these live remote MCP calls from a `.ai-pilot`-only sandbox. The Cursor SDK executes against a POSIX `local.cwd` (`Agent.create/resume` in `src/server/services/chatAgentService.ts`), so a local git checkout is a viable grounding source — git/grep cannot run against Blob directly, meaning Blob must serve as durable backing rather than a live filesystem.

**Scope.** In scope: a grounded local checkout for interview/ADR threads with repo MCP tools repointed to that checkout; a Blob-backed durable per-interview grounding artifact and lifecycle; signal-driven refresh keyed on the grounded base SHA; and the **internal** re-evaluate/impact-notification hook. The **public inbound endpoint**, Apex **API key** auth (in progress), and generated **YAML pipeline step** are captured as requirements only and deferred to a separate design. Out of scope: the interview/PRD product workflow itself and the already-shipped walkthrough anchor Sync.

**Constraints.** Azure App Service (ephemeral local FS; `/home/data` persistent and shared across instances; `WORKSPACE_BASE` already resolves there). Shared-async infra conventions (`.cursor/skills/azure-async-infra/SKILL.md`): one shared Storage Account per env, container-per-workload keyed `{userId}/{sessionId}/…`, managed identity + entity-scoped RBAC, no public containers; `infra/shared-async.tf` exposes `blob_containers` as a `for_each` map. Reusable machinery exists: `ensureRepoCache` + `materializeWorkspaceFromCache` + `repoCacheLeaseService`, `checkoutDefaultBranch` (`repoCheckoutService.ts`), `redactSecrets`/auth-env, the notification stack, the feature-flag system, and Blob exemplars (`pdfArtifactStore.ts`, `loadTestRunner/blobUploader.ts`, `avatarStore.ts`). Grounding is committed-truth (branch tip, not WIP). Interviews already receive an extended idle class (`INTERVIEW_IDLE_TIMEOUT_MS = 2h`). Infra edits under `infra/` are authorized as part of this workstream.

## Decision Drivers

- Remove the network/rate-limit/singleton/SDK-transport failure surface from the interview hot path.
- Keep multi-day interview grounding both fresh (advance to latest default branch) and durable, without consuming the App Service persistent share.
- Notify in-progress interviews when the underlying source materially changes, with low noise.
- Incremental, reversible rollout (implementation proceeds in small chunks).
- Reuse existing repo-cache/checkout/lease/notification infrastructure and follow shared-async infra conventions (no new account/namespace without an isolation driver).

## Considered Options

### Grounded local checkout (Blob-backed, feature-flagged)

Interview/ADR threads materialize a real local git checkout; repo MCP tools (`get_skill_file`, `list_repo_dir`, `search_repo_code`) read that checkout via a workspace profile. A per-interview `git bundle` in a dedicated Blob container is the durable artifact; the working tree is ephemeral local scratch, cold-clone-accelerated by the shared `ensureRepoCache` bare mirror on `/home/data`. Refresh is signal-driven on the grounded base SHA. The path is feature-flagged with graceful fallback to the current remote MCP.

- Benefits: repo reads become local git/grep (sub-second, no rate limit, no singleton, no live code-search on the hot path); ADO stuck calls leave the hot path; durable multi-day grounding without bloating `/home/data`; one SHA mechanism serves reopen-refresh and change notifications; reversible per-project rollout.
- Costs/risks: two code paths until the flag fully rolls out; cold-open latency on first materialize (mitigated by warm mirror + lease coalescing); new Blob container + RBAC + lifecycle rule; refreshing mid-interview can invalidate earlier cited lines; AI cost for change-relevance evaluation.

### Status quo — live remote MCP code search

Keep interviews grounding through `github-repo`/`ado-skills` remote MCP against the GitHub/ADO APIs.

- Benefits: no new infra; single code path.
- Costs/risks: retains the rate-limit, global-singleton, and SDK-transport wedge that cause the minutes-long hangs; no durable/fresh local grounding; does not address the ADO no-timeout path. Rejected — it leaves the primary defect in place.

### Persistent working tree on `/home/data` (no Blob)

Materialize each interview's checkout on the persistent `/home/data/workspaces` share, using it as the durable store.

- Benefits: fastest reopen; survives restarts; minimal new infra.
- Costs/risks: consumes the persistent share per in-flight interview (the quota problem Blob avoids); weaker per-interview isolation/teardown; no off-box durability. Rejected — defeats the "keep deep files off the App Service filesystem" driver.

## Decision Outcome

Chosen option: **Grounded local checkout (Blob-backed, feature-flagged)**, realized as the following sub-decisions:

1. **Repo access — workspace-profile MCP.** Add a `workspace`/`local` profile so the repo MCP tools back onto the interview's local checkout instead of `skillCatalogGitHub`/`skillCatalog`, keeping the interview prompt contract unchanged (smaller blast radius than switching interviews to built-in file tools, which is deferred).
2. **Durable artifact — per-interview `git bundle`.** A single-file branch-tip snapshot; rehydrate = download → clone → `git fetch origin <branch>`.
3. **Runtime model — hybrid.** Ephemeral per-interview working tree on local scratch; shared `ensureRepoCache` bare mirror on `/home/data` for warm cold-clone; durable bundle in Blob.
4. **Refresh — signal-driven on grounded base SHA.** Persist the `baseSha`; on reopen or branch-moved signal, compare to origin tip and reset the tree + raise a "source changed — re-evaluate" flag only when it moved.
5. **Lifecycle — checkpoint on idle/refresh, delete at PRD handoff.** The bundle is a warm-cache/grounding snapshot; interview content stays in `chat_messages`, so completed interviews remain openable from the DB after bundle deletion.
6. **Failure/rollout — feature-flagged with graceful fallback.** On materialization failure, transparently fall back to the current remote MCP; enable per project/env and revert instantly.
7. **Blob isolation — new `interview-workspaces` container.** Keyed `{userId}/{interviewId}/mirror.bundle`, added to `blob_containers` in `infra/shared-async.tf`, private, managed identity with container-scoped Blob Data Contributor, plus a lifecycle TTL (~7–14d) as a backstop to the app-level delete.
8. **Internal impact hook — SHA-diff + AI relevance gate → targeted notify.** On a branch-moved signal, find in-progress interviews behind the tip, AI-evaluate the diff against each interview's context, and notify the author via the existing notification/toast system only when relevant.

This best satisfies the drivers: it removes the live code-search dependency that causes the hangs, delivers durable-yet-fresh grounding off the persistent share, reuses existing cache/lease/notification infrastructure, and remains reversible through the feature flag while infra follows the shared-async conventions.

## Consequences

### Positive

- Eliminates the primary interview-hang trigger; repo reads become local git/grep (no rate limit, no singleton, no 35s+ tool calls feeding the SDK transport race).
- ADO parity: stuck ADO repo calls no longer sit on the interview hot path.
- Durable, multi-day grounding with per-interview isolation and clean teardown, without bloating `/home/data`.
- A single stored-SHA mechanism powers both reopen-refresh and external change notifications, with an AI relevance gate to keep notifications low-noise.
- Reversible, per-project rollout via the existing feature-flag system supports small-chunk delivery.

### Negative

- Two code paths (grounded-checkout + remote-MCP fallback) are maintained until the flag is fully rolled out.
- Cold-open latency on first materialize/rehydrate (mitigated by the shared warm mirror and lease coalescing).
- New Blob container, RBAC, and lifecycle rule under `infra/` (authorized in this workstream) plus `src/server/index.ts` wiring.
- Refreshing to the latest tip mid-interview can invalidate earlier cited line numbers/files (record grounded SHA/date).
- AI evaluation cost per impacted in-progress interview per branch move.
- Unresolved risks: the residual Cursor SDK/MCP transport wedge is mitigated but not structurally fixed (separate durable-worker/event-completion ADR); cross-instance concurrency for the same interview must reuse `repoCacheLeaseService` + `workspaceMutex`; bundle corruption or a GC'd grounded SHA falls back to a fresh origin clone; the exact `/to-prd` teardown hook point and observability metrics (materialize time, cache hit/miss, fallback rate, notification volume) remain to be finalized. The public endpoint / API-key / YAML contract is a documented dependency deferred to a separate design.

## References

- `src/server/services/skillCatalogGitHub.ts` — `searchRepoCode` (rate limit, singleton, throttle).
- `src/server/mcp/github/server.ts` — repo MCP tools and `raceWithTimeout`.
- `.cursor/skills/hung-interview-troubleshoot/SKILL.md` — interview hang failure modes (esp. A).
- `src/server/services/chatAgentService.ts` — `Agent.create/resume` `local.cwd`, `buildMcpServers`, `WORKSPACE_BASE`, interview idle class, `preloadRepositoryContext`/`repoSearchEnabled`.
- `src/server/services/repoCheckoutService.ts`, `repoCacheService.ts`, `repoWorkspaceService.ts`, `repoCacheLeaseService.ts` — cache/materialize/lease machinery.
- `infra/shared-async.tf`, `infra/variables.tf`, `infra/outputs.tf`, `infra/README.md` — `blob_containers` map and shared storage outputs.
- `.cursor/skills/azure-async-infra/SKILL.md` — shared Blob/Service Bus topology conventions.
- `.cursor/skills/terraform-infra/SKILL.md` — Terraform file layout, identity/RBAC, and README/output contracts for `infra/` delivery.
- Blob exemplars: `src/server/services/pdfArtifactStore.ts`, `src/server/services/loadTestRunner/blobUploader.ts`, `src/server/services/avatarStore.ts`.
- Notifications: `notificationService`, `aiCompletionNotifier`.
- Interview lifecycle: `src/server/services/interviewService.ts`, `.cursor/skills/to-prd/SKILL.md`.
- Decision transcript: `.ai-pilot/kickoff-transcript.md`.
