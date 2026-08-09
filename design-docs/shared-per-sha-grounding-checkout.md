# Shared, Read-Only Per-SHA Grounding Checkout

**Status:** Proposed
**Area:** Grounding / AI-run workspace materialization
**Feature flag:** `shared-readonly-grounding-checkout` (default off)

## Problem

Every repository-reading chat session (interview, ADR, PRD/design-doc assistants,
agent-home, walkthrough, design-module, Ask Apex) pays a workspace "preparing"
cost on its first turn — even when the target branch (`main`) has not moved and
every session grounds at the **same SHA**.

The cost is not a re-clone. The bare **repo mirror** and the per-SHA **grounding
bundle** are already shared. The cost is that the **materialized working
checkout** is keyed per session, so each thread materializes its own tree
(`git materialize-from-cache` + `git checkout --detach <sha>`).

The destination digest includes the run/thread id:

```58:78:src/server/services/runGroundingMaterializer.ts
function opaqueDestination(
  dataRoot: string,
  grounding: RunGrounding,
  destinationRun: RunRef
): string {
  const identity = JSON.stringify([
    destinationRun.runType,
    destinationRun.runId,        // ← makes the checkout per-session
    destinationRun.project,
    grounding.repoRole,
    grounding.provider,
    grounding.repository,
    grounding.branch,
    grounding.groundedSha,
  ]);
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return path.join(dataRoot, 'workspaces', 'grounding', digest);
}
```

Because `runId` is in the key, no two sessions share a tree, so identical-SHA
sessions never reuse each other's work.

### On-disk topology — the pause is a full working-tree clone, not a fetch

The repo is **already on disk** before any session starts. `resolveDataRoot()`
returns `/home/data/ai-pilot` on App Service — a persistent mount shared across
scaled instances — and the same `workspaces` mount is resolved by the background
workers and the interactive actor host.

- **Bare mirror (already present, shared):**
  `<dataRoot>/repo-cache/<...>` — a `--bare` mirror. Reused across all sessions.
- **Per-run working tree (rebuilt every session):**
  `<dataRoot>/workspaces/grounding/<digest>` — created per run by
  `materializeWorkspaceFromCache`, which does a full working-tree clone from the
  already-local bare mirror:

```30:44:src/server/services/repoWorkspaceService.ts
    await git(
      safeArgs(cacheDir, [
        '-c',
        'core.longpaths=true',
        'clone',
        '--reference',
        cacheDir,
        '--no-local',
        '--no-hardlinks',
        '--single-branch',
        '--branch',
        branch,
        cacheDir,
        workspaceDir,
      ]),
```

So the "preparing" pause is **not** a network clone — the mirror is local. It is
a full working-tree materialization (`--no-hardlinks` → real object/file copy)
onto Azure Files, written **once per run**, even when the SHA is identical. That
per-run clone is exactly the waste this design removes: materialize the working
tree **once per SHA** and mount it read-only for every session at that SHA.

## Why we can't just drop `runId`

The same materializer + `workspaceRef` path is used by the **writing background
generation lane**, whose isolation depends on that per-run key:

```275:282:src/server/services/backgroundWorkflowRouter.ts
    const snapshot: ExecutionSnapshot = {
      prompt: prepared.prompt,
      model: prepared.model,
      workspaceRef: materialized.workspacePath,   // same opaqueDestination
      workflowClass: input.workflowClass,
      skillPath: prepared.skillPath,
      projectId: prepared.projectId,
      threadId: input.threadId,
    };
```

Background runs (`/to-prd`, `prd-design-spec`, design-doc generation, test-case
generation, design-doc validation) execute the **full write agent**
(`createLocalCursorExecution`, no read-only tool restriction) and then
`flushWorkspaceArtifacts` writes `.ai-pilot/output`. Two concurrent generations
at the same SHA sharing one directory would corrupt each other. Dev sessions and
the in-process/attachment fallback also write into the workspace.

**Conclusion:** the fix must be **scoped to read-only sessions**, not applied at
the materializer level for everyone. `runId` isolation stays load-bearing for
writers.

## Goal

For read-only, repository-reading chat sessions, materialize **one shared,
read-only checkout per `(provider, project, repo, branch, sha)`** and let every such
session mount it as `Agent.local.cwd`. New sessions at an unchanged SHA become
near-instant; a new SHA naturally produces a new shared checkout ("reground").

Non-goal: change behavior for writing runs (background generation, dev sessions,
attachment/in-process turns). Those keep isolated per-run checkouts.

### Reground policy — session discretion, not global follow-tip

This change does **not** make chats follow `main`'s tip. Each session stays
pinned to the SHA it grounded at (its durable grounding row) and only re-grounds
deliberately — via the existing staleness thresholds / stale-run recovery, or an
explicit per-session reground. When a session does reground, it simply resolves
a new SHA and mounts that SHA's shared tree; other sessions on the old SHA are
untouched (different SHA → different tree). SHA selection remains at the
session's discretion; sharing only changes where the bytes live, never which SHA
a session sees.

## Which callers qualify (read-only)

Gate on the execution being **native-read only**, not on a hard-coded caller
list. A session qualifies when both hold:

- `isRepositoryReadingChatCaller(kickoff, isDevSession)` is true, and
- the resolved execution uses `createNativeReadTools(...)` with **no** write
  tools (the interactive actor path already does exactly this).

```37:38:src/server/services/interactiveActorHost/interactiveCursorExecution.ts
    settingSources: ['project'],
    customTools: createNativeReadTools(checkout),
```

Everything else (background writers, dev sessions, calendar assistant, and any
turn carrying attachments) is excluded and continues on the per-`runId` path.

## Design

### 1. A distinct shared-read destination

Add a **separate** destination resolver that keys only on repo identity + SHA
(no `runId`, no `runType`), under a distinct root so it never collides with
per-run trees or the eviction scan for those:

```
<dataRoot>/workspaces/grounding-shared/<sha256(provider,project,repo,branch,sha)>
```

`project` is part of the digest so identical repo/branch/SHA in two Apex
projects never collide.

Keep `opaqueDestination` untouched for per-run writers. Introduce
`resolveSharedReadCheckoutPath(identity)` and a `materializeSharedReadCheckout`
that reuses the existing bundle-store rehydrate + pinned-SHA checkout logic, but
writes to the shared path.

### 2. Materialize under a lease (no cold-start race)

Two sessions hitting a cold SHA simultaneously must not both run
`git checkout --detach`. Reuse the existing Postgres lease primitive keyed by the
shared identity:

```93:97:src/server/services/repoCacheLeaseService.ts
export async function withRepoCacheLease<T>(
  cacheKey: string,
  operation: (lease: RepoCacheLeaseContext) => Promise<T>,
  options: RepoCacheLeaseOptions = {},
): Promise<T> {
```

Flow: fast-path check "already materialized + marker present" → if absent,
acquire `withRepoCacheLease('grounding-shared:<identity>')`, re-check inside the
lease, materialize if still cold, drop a `.apex-ready` marker file, release.
Waiters re-check and hit the warm tree. `assertOwned()` guards the checkout step.

### 3. Ref-count so eviction can't delete a live tree

The current per-run `release()` marks the run's grounding inactive and the
eviction sweep deletes unprotected, idle directories:

```70:85:src/server/services/groundingEvictionService.ts
        if (protectedNames.has(entry.name)) {
          result.protected += 1;
          continue;
        }
        const workspace = path.join(workspacesRoot, entry.name);
        try {
          const stats = await fs.stat(workspace);
          if (now() - stats.atimeMs <= GROUNDING_WORKSPACE_IDLE_TTL_MS) {
            continue;
          }
          await fs.rm(workspace, { recursive: true, force: true });
```

For shared trees, a per-run release is wrong — another session may still be
reading. Introduce an in-process **ref-count** keyed by shared identity:

- On session start (after mount): `retain(identity)`.
- On session `release()`: `releaseRef(identity)` (decrement only; never delete).
- Deletion is owned exclusively by the eviction sweep (below).

Ref-counts are per API instance. The eviction sweep must therefore not rely
solely on in-memory refs (another instance may hold users) — it uses the DB +
idle TTL as the source of truth and treats in-memory refs as an additional local
guard.

### 4. Evict by SHA staleness + idle TTL, not per-run

Extend the eviction sweep with a second pass over
`workspaces/grounding-shared/*`:

- **Protected** if the `(provider, project, repo, branch)` still resolves to this
  SHA (i.e. it is the current grounded SHA for an active target) — never delete
  the live SHA's shared tree.
- Otherwise eligible when idle beyond the 30-min TTL **and** no local ref-count
  is held.
- Deletion uses the same lease key to avoid racing a concurrent materialize.

**Idle is measured by an explicit last-use sidecar, not directory `atime`.** A
sibling `<digest>.lastused` file (kept beside the tree so the tree stays pristine
for future read-only `chmod`) is refreshed on cold materialize, warm hit, and
release. This is deliberate: Azure Files (App Service `/home`) has unreliable
`atime` semantics and a warm hit never touches the tree, so `atime` would age a
live-but-warm tree out. Eviction reads the sidecar and falls back to directory
`mtime` only when it is missing.

This gives the "reground on new SHA" behavior: when `main` advances, the old
shared tree ages out and the next session materializes the new SHA once.

### 5. Enforce read-only

Treat the shared tree as immutable so a stray write can't leak across sessions:

- Sessions mount it only with `createNativeReadTools` (already the case) and no
  write/edit tools and no repo MCP.
- Belt-and-suspenders: set the tree read-only after materialization
  (`chmod -R a-w` on POSIX / ACA mount), and skip `flushWorkspaceArtifacts` for
  read-only sessions (they produce no `.ai-pilot/output`).
- Any write need (e.g. `update_adr`) is already a **tool/DB** operation, not a
  filesystem write into the checkout, so it is unaffected.

### 6. Wire-in points

- `callerGroundingService.startLocal`: when the selection is read-only-eligible,
  resolve/materialize the shared-read checkout and return its path as `cwd`
  (instead of the per-run `materialized.workspacePath`). `release()` calls
  `releaseRef(identity)` instead of deleting.
- Interactive actor `openWarmCheckout`: unchanged in shape — it still opens
  `snapshot.workspaceRef`; that ref now points at the shared tree for read-only
  threads. The actor's per-thread in-memory warm-checkout cache still accelerates
  subsequent turns of the same thread.
- Background lane, dev sessions, attachment/in-process turns: unchanged
  (per-`runId` `opaqueDestination`).

## What stays per-run (unchanged)

- Background generation (`/to-prd`, `prd-design-spec`, design-doc, test-case,
  validation) — writes + flush.
- Dev sessions — own checkout lifecycle, git writes.
- Calendar assistant — no repo browse.
- Any interactive turn with attachments (`tryDispatchInteractiveTurn` already
  bails to the in-process path when `attachments.length > 0`).

## Telemetry

- `grounding.shared.checkout` `{ outcome: 'hit' | 'materialized' | 'wait' }`
  with `durationMs` — proves reuse and shows first-vs-subsequent cost.
- `grounding.shared.eviction` `{ scanned, evicted, protected }`.
- Keep existing `grounding.mirror` / `grounding.bundle.publish` events; add a
  `sharedReuse: true|false` dimension to first-turn preparation timing so we can
  quantify the win.

## Rollout

- Behind `shared-readonly-grounding-checkout` (default off), gated per project so
  we can enable on Apex/scrum-dev first.
- Flag off → byte-for-byte current behavior (per-`runId` read checkouts).
- Rollback = disable flag; shared trees age out via the eviction TTL.
- Cleanup markers `@feature-flag:shared-readonly-grounding-checkout`.

## Testing

- **Unit**
  - `resolveSharedReadCheckoutPath` ignores `runId`/`runType`; identical for two
    different runs at the same `(provider, project, repo, branch, sha)`; differs
    when SHA changes.
  - Ref-count retain/release; eviction skips a tree with a live ref and the
    current-SHA tree; evicts a stale, idle, unreferenced tree.
  - Last-use: a warm hit refreshes the `.lastused` sidecar so an unreferenced
    tree survives eviction; eviction falls back to directory `mtime` when the
    sidecar is missing.
  - Lease serializes concurrent cold materialization (one checkout, others wait
    then hit the marker).
  - Read-only enforcement: writer callers never resolve the shared path.
- **Integration**
  - Two read-only threads at the same SHA → one materialization, second mounts
    instantly; both read identical content.
  - New commit advances SHA → new shared tree; old one evicted after TTL.
  - Background generation still isolates per run and flushes artifacts.
- **Concurrency**
  - N simultaneous cold sessions → exactly one `git checkout --detach`.

## Risks & mitigations

- **Cross-session bleed:** mitigated by strict read-only mount + `chmod` and no
  write tools/MCP.
- **Premature deletion of a live tree:** mitigated by ref-count + current-SHA
  protection + lease-guarded deletion + idle TTL.
- **Multi-instance ref-count gaps:** eviction relies on DB active-target + idle
  TTL as source of truth, not only in-memory refs.
- **Marker/partial materialization:** `.apex-ready` marker written only after a
  successful checkout; absence forces re-materialize under lease.

## Out of scope

- Sharing checkouts for writing runs.
- Cross-instance shared **filesystem** semantics beyond the existing Azure Files
  mount (the shared tree lives under the same `workspaces` mount all compute
  already resolves).
- Changing the mirror or bundle-publish design (already shared per-SHA).

## Implementation status (shipped, flag-gated)

Delivered behind the `shared-readonly-grounding-checkout` flag (seeded
`enabled=true` with an Apex-only project rule; off elsewhere until Platform
Admin adds rules).

- **Service:** `src/server/services/grounding/sharedReadCheckoutService.ts` owns
  the SHA-keyed path (`<dataRoot>/workspaces/grounding-shared/<sha256(provider,
  project, repo, branch, sha)>`), lease-guarded cold materialization (one
  `git checkout --detach` under `withRepoCacheLease`, `.apex-shared-ready`
  marker written last), an in-process ref-count, and idle-TTL eviction that
  protects any SHA an active grounding pins and any ref-held tree.
- **Wire-in point (revised):** integration lives in
  `callerGroundingService.startLocal` (not the run-grounding materializer). When
  a caller passes `readOnlyShareable` and the flag is on, `startLocal`
  materializes/reuses the shared tree, `retain`s it, and points both the
  connection-profile `checkoutPath` and the returned `cwd` at it — **skipping the
  per-run clone entirely**. `release()` calls `releaseRef`; eviction reclaims by
  TTL. Any shared-path failure falls back to the per-run materialization.
- **Read-only by construction (revised):** no recursive `chmod` in v1. The chat
  path already treats `grounding.cwd` as read-only — every write (kickoff files,
  attachments, agent `cwd`) targets the separate per-thread `thread.workspaceDir`
  (`chatAgentService.prepareRepositoryReadRuntime` sets `sandboxCwd:
  state.thread.workspaceDir`). Recursive `chmod` on a large tree would reintroduce
  the very latency this removes, so it is deferred as optional hardening.
- **Caller gating:** `chatAgentService.ensureThreadGrounding` sets
  `readOnlyShareable: true` — reached only for `isRepositoryReadingChatCaller`
  (interview, ADR, PRD/design-doc assistants, agent-home, walkthrough, design
  module). Dev sessions and calendar return remote; the background **writing**
  lane (`backgroundWorkflowRouter` → `materializeRunGroundingWithPath`) is a
  different path and keeps per-run isolation.
- **Eviction:** `groundingMaintenanceScheduler.runNow` now also calls
  `sharedReadCheckoutService.evictIdle()` after the existing per-run sweep.
- **Tests:** `sharedReadCheckoutService.test.ts` (path/hit/lease-race/ref-count/
  eviction) and new shared-path cases in `callerGroundingService.test.ts`
  (uses shared tree when on, per-run when off, never shares for non-read-only
  callers, falls back on materialize failure).

**Cleanup plan:** retain the enabled branch after two stable sprints at full
rollout; then inline via `/feature-flag-cleanup shared-readonly-grounding-checkout`.
