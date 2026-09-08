# ADR Interview Transcript — Grounded-Checkout Interviews with Blob-Backed Workspace

> Status: ready for ADR generation (`/adr-finalize`).
> Interview type: architecture decision (senior-principal-engineer grounding).
> This transcript captures decisions, drivers, considered options, and consequences. It is not the final ADR.

---

## 1. Problem & Decision to Resolve

Interview (and ADR) chat turns hang, most commonly pinned on the GitHub `search_repo_code` MCP call (and the ADO equivalent). Root causes verified in code:

- `searchRepoCode` hits GitHub's live `/search/code` API — ~10 req/min cap, a **global singleton** (`activeCodeSearch`) that rejects overlapping searches, and throttle/rate-limit branches (`src/server/services/skillCatalogGitHub.ts`).
- Even though the GitHub MCP handlers wrap calls in `raceWithTimeout` (~35s, `src/server/mcp/github/server.ts`), hangs last **minutes** — the Cursor SDK/MCP Streamable HTTP stream does not always observe tool completion (documented in `.cursor/skills/hung-interview-troubleshoot/SKILL.md`, failure mode A).
- The ADO repo MCP tools are **not** wrapped in `raceWithTimeout`, so a stuck ADO call pins the turn until cancel/reaper.

**Decision:** Restructure interview/ADR grounding so the agent reads a **real local git checkout** via workspace-profile MCP tools (no live code-search API on the hot path), backed durably by **Azure Blob**, with a signal-driven refresh and an internal impact-notification hook when the grounded default branch moves.

**Primary drivers:**
1. Eliminate the live GH/ADO `search_repo_code` hang (latency, rate-limit, singleton contention, SDK transport wedge).
2. Keep long-lived interview grounding **fresh** (advance to latest default branch) and **durable** across days without consuming the App Service persistent share.
3. Provide a mechanism to notify in-progress interviews when the underlying source materially changes.

---

## 2. Scope

**In scope (this ADR):**
- Grounded local checkout for interview/ADR threads; repo MCP tools repointed to the checkout (**Option A** — workspace-profile MCP, see §5.1).
- Blob-backed durable per-interview grounding artifact + lifecycle.
- Signal-driven refresh keyed on grounded base SHA.
- The **internal** re-evaluate/impact-notification hook (SHA-diff + AI relevance gate → targeted in-app notification).

**Documented dependency (requirements captured here, build-out deferred to a later discussion):**
- The **public inbound endpoint** customers call from their ADO/GitHub default-branch pipeline, the **Apex API key** auth (generation in progress), and the **YAML pipeline step** Apex generates for them. See §8. This ADR records requirements only; the endpoint/contract will be designed separately.

**Out of scope:**
- Changing the interview/PRD product workflow itself.
- The walkthrough anchor Sync work (separate, already shipped).

---

## 3. Constraints (fixed)

- **Runtime:** Azure App Service. Local working files are ephemeral; `/home/data` (`resolveDataRoot()`) is persistent and shared across instances. `WORKSPACE_BASE` already resolves to `/home/data/.../workspaces` on App Service (`src/server/services/chatAgentService.ts`).
- **Agent execution:** Cursor SDK runs against a POSIX `local.cwd` (`Agent.create/resume` in `chatAgentService.ts`). Git/grep cannot run against Blob directly — Blob is durable backing, not a live filesystem.
- **Infra conventions (`.cursor/skills/azure-async-infra/SKILL.md`):** one shared Storage Account per env, container-per-workload keyed `{userId}/{sessionId}/…`, managed identity + entity-scoped RBAC, no public/anonymous containers, Postgres preferred over a broker at current scale. `infra/shared-async.tf` exposes `blob_containers` as a `for_each` map (adding a container is a one-key change).
- **Existing machinery to reuse:** `ensureRepoCache` + `materializeWorkspaceFromCache` + `repoCacheLeaseService` (bare mirror on `/home/data/repo-cache`, lease coalescing), `checkoutDefaultBranch` (`repoCheckoutService.ts`), `redactSecrets`/auth-env, notification stack (`notificationService`, `aiCompletionNotifier`), feature-flag system, Blob client exemplars (`pdfArtifactStore.ts`, `loadTestRunner/blobUploader.ts`, `avatarStore.ts`).
- **Committed-truth grounding:** the checkout is the branch tip, not anyone's uncommitted WIP.
- **Interview idle class:** interviews already get an extended idle timeout (`INTERVIEW_IDLE_TIMEOUT_MS = 2h`).

---

## 4. Decision Drivers

- Remove the network/rate-limit/singleton/SDK-transport failure surface from the interview hot path.
- Durability of grounding across multi-day interviews without bloating `/home/data`.
- Incremental, reversible rollout (author will implement in small chunks).
- Reuse of the existing repo-cache/checkout/lease/notification infrastructure.
- Keep noise low on change notifications (relevance-gated).
- Follow shared-async infra conventions; avoid new accounts/namespaces without an isolation driver.

---

## 5. Decisions (considered options + selected)

### 5.1 Repo access mechanism — **Option A: workspace-profile MCP**
Add a `workspace`/`local` profile to the repo MCP servers so `get_skill_file`, `list_repo_dir`, `search_repo_code` back onto the interview's local checkout instead of `skillCatalogGitHub`/`skillCatalog`. The interview prompt keeps its "use MCP tools" contract, so skill text barely changes.
- **Rejected — built-in file tools (dev-session style):** cleaner long-term but changes interview prompts and the `preloadRepositoryContext`/`repoSearchEnabled` flags broadly; larger blast radius. May revisit later.
- **Driver:** smallest blast radius; isolates risk; identical interview UX.

### 5.2 Durable Blob artifact — **per-interview `git bundle`**
Single-file snapshot of the grounded branch tip. Rehydrate = download bundle → clone → `git fetch origin <branch>` for latest.
- **Rejected — full working-tree tarball:** larger objects, slower up/down, still needs a fetch for latest.
- **Rejected — shared bare mirror in Blob + per-interview `.ai-pilot` blob:** most storage-efficient but reintroduces a shared-object lock that cuts against per-interview isolation/teardown.
- **Driver:** tiny, isolated per interview, clean teardown, natural "fetch latest on reopen."

### 5.3 Runtime materialization — **Hybrid**
Per-interview working tree on **ephemeral local scratch** (`os.tmpdir`); cold-clone accelerated by the shared **`ensureRepoCache` bare mirror on `/home/data`**; durable per-interview **bundle in Blob**.
- **Rejected — persistent tree on `/home/data/workspaces`:** fastest reopen but consumes the persistent share per in-flight interview (the quota problem Blob is meant to avoid).
- **Rejected — pure-ephemeral (no `/home/data` mirror):** most "off-box" but every cold open pays a full bundle download + fetch with no warm cache.
- **Driver:** disposable per-interview trees, deduped warm mirror, Blob durability, lease coalescing already exists.

### 5.4 Refresh semantics — **Signal-driven on grounded base SHA**
Persist the base SHA the interview was grounded on (we already surface `baseSha` from `ensureRepoCache`). On reopen — or on a branch-moved webhook — compare to origin tip. If changed: fetch + reset the working tree to the new tip and raise a "source changed — re-evaluate" flag for the agent/author. If unchanged: reuse as-is.
- **Rejected — always hard-reset on reopen:** silently shifts ground truth even when nothing changed; discards the change signal.
- **Rejected — manual-only "Update to latest":** stale by default; burden on the user.
- **Driver:** one SHA-comparison mechanism serves both reopen and the external branch-change notification.

### 5.5 Persist + teardown lifecycle — **Checkpoint on idle/refresh; delete at PRD generation**
Write/refresh the bundle when a session goes idle and whenever a refresh advances the SHA. Delete the bundle when the interview hands off to `/to-prd`. Ephemeral scratch tree is torn down each idle and rebuilt on reopen. Interview content itself remains continuously persisted in `chat_messages`, so a completed interview is still openable from the DB after the bundle is gone; a rare post-PRD reopen can rebuild a bundle from origin if the grounded SHA is still reachable.
- **Rejected — write-once-at-start:** bundle drifts from refreshed tip.
- **Rejected — write-every-turn, delete-at-archive:** more Blob writes; retains source longer than needed.
- **Driver:** bundle is a warm-cache/grounding snapshot, not the system of record; matches "gone from Blob once context is captured, still openable from DB."

### 5.6 Failure mode + rollout gating — **Feature-flagged with graceful fallback to remote MCP**
The grounded-checkout path is gated per project/env via the existing feature-flag system. If materialization fails (Blob outage, cold-clone failure, origin unreachable), the interview transparently falls back to today's `github-repo`/`ado-skills` remote MCP so it still works (slower, old hang risk) rather than blocking.
- **Rejected — degraded-local then hard-fail:** a full outage blocks interviews; no old-path safety net.
- **Rejected — hard cutover:** any materialization failure blocks interviews; no incremental safety during rollout.
- **Driver:** small-chunk rollout, instant revert, per-project enablement.

### 5.7 Blob isolation & governance — **New shared-account container `interview-workspaces`**
Keyed `{userId}/{interviewId}/mirror.bundle`; added to `blob_containers` in `infra/shared-async.tf`; private access only; managed identity with **container-scoped** Blob Data Contributor for the Apex app identity; **lifecycle-management TTL** (≈7–14d) as a backstop to the app-level delete-at-PRD.
- **Rejected — reuse `pdf-artifacts` under a prefix:** breaks container-per-workload isolation; muddies RBAC/lifecycle scoping.
- **Rejected — dedicated Storage Account:** contradicts "one account per env" default; no formal source-sensitivity isolation driver established (Apex targets internal repos).
- **Driver:** follows shared-platform default; per-`{userId}/{interviewId}` isolation; TTL prevents orphaned bundles from lingering after a crash.

### 5.8 Internal impact-notification hook — **SHA-diff + AI relevance gate → targeted notify**
On a branch-moved signal, find in-progress interviews grounded on that repo/branch whose stored base SHA is behind, run an AI evaluation of the diff against each interview's captured context, and notify the author via the existing in-app notification/toast system **only when the change is judged relevant** ("source changed, get latest & re-evaluate").
- **Rejected — SHA-diff only, notify all:** noisy; pings authors for unrelated merges.
- **Rejected — mark-stale banner only:** no proactive alert until reopen.
- **Driver:** reuses `notificationService`/`aiCompletionNotifier` + the stored SHA; relevance gate controls noise. Cost: one bounded AI call per impacted in-progress interview per branch move.

---

## 6. Consequences

**Positive**
- Removes the primary interview-hang trigger; repo reads become local git/grep (sub-second, no rate limit, no singleton).
- ADO parity: stuck ADO repo calls leave the hot path too.
- Durable, multi-day grounding without bloating `/home/data`; per-interview isolation and clean teardown.
- One SHA mechanism powers reopen-refresh and external change notifications.
- Reversible, per-project rollout via feature flag.

**Negative / costs**
- Two code paths (grounded-checkout + remote-MCP fallback) maintained until the flag fully rolls out.
- Cold-open latency on first materialize/rehydrate (mitigated by shared warm mirror + lease coalescing).
- New Blob container + RBAC + lifecycle rule — infra change under `infra/` (plus `src/server/index.ts` wiring; `package.json` already has `@azure/storage-blob`). These infra edits are **authorized as part of this workstream** (owner approved), so they are handled within the implementation, not deferred for separate sign-off.
- Refreshing to latest tip mid-interview can invalidate earlier cited line numbers/files (acceptable; note grounded SHA/date in transcript).
- AI evaluation cost for change notifications (bounded to in-progress interviews on moved branches).

---

## 7. Unresolved Risks / Follow-ups
- Residual Cursor SDK/MCP transport wedge (failure mode A) is **mitigated** (no more 35s+ calls) but not structurally fixed — the durable-worker/event-completion path remains a separate ADR.
- Concurrency: same interview opened on two instances — reuse `repoCacheLeaseService` + `workspaceMutex`; confirm lease scope covers per-interview scratch + bundle write.
- Bundle corruption / missing grounded SHA on origin (branch force-push, GC) → fall back to fresh origin clone at current tip and re-ground (flag as "source changed").
- Exact `/to-prd` handoff event that triggers bundle delete needs a precise hook point.
- Observability: metrics for materialize time, cache hit/miss, fallback rate, notification volume.

---

## 8. Public API / Webhook Requirements (documented dependency — build-out deferred)

Captured now so the internal hook has a clear contract to integrate against; the endpoint itself is a separate design discussion.

- **Purpose:** let a customer's ADO/GitHub pipeline notify Apex when the **default branch** of a targeted project is updated (post-merge), so Apex can run the §5.8 impact evaluation against in-progress interviews.
- **Auth:** Apex-issued **API key** (generation in progress). Requirements: per-project/tenant key, revocable, scoped to the change-notification endpoint only, transmitted as a header (not query), rate-limited, auditable.
- **Customer-added artifact:** Apex generates a **YAML pipeline step** (ADO pipeline task / GitHub Actions step) the customer adds to their default-branch merge pipeline. It calls the Apex public endpoint with repo identity, branch, new commit SHA (and prior SHA if available), and the API key.
- **Inbound contract (to be finalized later):** provider (github|ado), repo identifier, default branch name, new tip SHA, optional changed-file list / diff URL, timestamp, signature/HMAC option.
- **Endpoint requirements:** public but authenticated; idempotent per (repo, sha); fast ack + async processing (enqueue, then run §5.8); abuse/rate protection; no repo source in the request body (Apex fetches via its own credentials).
- **Boundary:** the endpoint only **signals**; all source fetching + AI evaluation happen inside Apex using the grounded-checkout mechanism from this ADR.

---

## 9. References
- `src/server/services/skillCatalogGitHub.ts` — `searchRepoCode` (rate limit, singleton, throttle).
- `src/server/mcp/github/server.ts` — repo MCP tools + `raceWithTimeout`.
- `.cursor/skills/hung-interview-troubleshoot/SKILL.md` — failure modes (esp. A: minutes-long MCP wedge).
- `src/server/services/chatAgentService.ts` — `Agent.create/resume` `local.cwd`, `buildMcpServers`, `WORKSPACE_BASE`, interview idle class, `preloadRepositoryContext`/`repoSearchEnabled`.
- `src/server/services/repoCheckoutService.ts`, `repoCacheService.ts`, `repoWorkspaceService.ts`, `repoCacheLeaseService.ts` — cache/materialize/lease.
- `infra/shared-async.tf`, `infra/variables.tf`, `infra/outputs.tf`, `infra/README.md` — `blob_containers` map + shared storage outputs.
- `.cursor/skills/azure-async-infra/SKILL.md`, `.cursor/skills/terraform-infra/SKILL.md` — infra conventions.
- Blob exemplars: `src/server/services/pdfArtifactStore.ts`, `src/server/services/loadTestRunner/blobUploader.ts`, `src/server/services/avatarStore.ts`.
- Notifications: `notificationService`, `aiCompletionNotifier`.
- Interview lifecycle: `src/server/services/interviewService.ts` (status `in_progress`/`complete`/`archived`), `.cursor/skills/to-prd/SKILL.md`.
