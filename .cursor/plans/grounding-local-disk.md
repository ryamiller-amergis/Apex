# Grounding checkouts on local disk (stop prod DB timeouts)
Updated: 2026-11-02. Repo: Apex. Branch: feature/feat-010-task-dispatcher (plan only; implement on its own branch)

## Goal
App Service no longer clones or deletes grounding working trees on the Azure Files share (`/home`).
Done when, on prod for 48h: zero `Connection terminated due to connection timeout` in container logs,
Node libuv workers not stuck in `D` state, and grounding clone p95 < 2 min (today 9–52 min).

## Why (prod evidence, 2026-10-30 and 2026-11-02)
- Every new pg/HTTP connection needs a libuv thread for `dns.lookup`. All 4 libuv workers in the
  prod node process were in `D` state on CIFS (`rmdir`/`unlink`/`statx`, wchan `wait_for_response`)
  deleting `workspaces/grounding/<digest>.removing-*`. New pg connects exceed the 10s
  `connectionTimeoutMillis` (`src/server/db.ts:25`) and the session lookup fails the page.
- DB, SNAT, CPU, memory, host DNS/TCP all healthy. Fresh instances go bad within 1–5h.
- Started 2026-10-27, after 4813a871 (2026-10-26) swapped `fs.rmSync` for `fs.promises.rm`
  (event-loop block became threadpool block) and 60a108a7 added a clone retry.
- Today: 178 materialize starts, 130 failed (`git clone made no progress for 300000ms`, or the
  30-min timeout). Each start and each failure deletes a whole checkout over SMB.

## Constraints & decisions
- The share path is a contract today: App Service, the ai-runs worker Job and the interactive host
  all mount it at `/home/data/ai-pilot/workspaces` and get `workspaceRef =
  <dataRoot>/workspaces/grounding/<digest>` (`infra/variables.tf:587-600`). Local disk breaks that
  for anything that runs outside the App Service process, so cross-process runs need their own copy.
- Worker settings come from App Service via the execution spec; workers hold no defaults
  (`.cursor/rules/v2-worker-no-policy.mdc`). A local-root path for workers must be resolved by
  App Service and carried in the spec.
- Gate the switch behind a new feature flag (`.cursor/skills/feature-flags/SKILL.md`), per project.
- Ask before touching `infra/`, app settings, `package.json`, `src/server/index.ts`.
- App Service local disk: overlay, 74G total / 40G free per instance, ephemeral (wiped on restart).
  Share: 250G, 11G used, 47 grounding checkouts, 8 repo-cache mirrors.

## Key files
- src/server/services/repoWorkspaceService.ts:16-33: `removeDirectoryAsync` (rename, then `fs.promises.rm`)
- src/server/services/repoWorkspaceService.ts:47-127: clone from mirror, retry, delete on fail
- src/server/services/runGroundingMaterializer.ts:97-115: destination = share path (opaque digest)
- src/server/services/runGroundingMaterializer.ts:314-432: `materializeLocalOnly` (flag-on path).
  Line 357 uses `fs.rmSync` on the share, which blocks the event loop.
- src/server/services/runGroundingMaterializer.ts:434-484: entry, checkout-readiness flag branch
- src/server/services/grounding/bundleStoreService.ts: Blob bundle publish/rehydrate (bypassed
  when `project-repository-checkout-readiness` is on, see runGroundingMaterializer.ts:183-197)
- src/server/services/groundingEvictionService.ts:38-80: evicts share checkouts with `fs.rm`
- src/server/services/repoCheckoutService.ts:110,155: other `removeDirectoryAsync` callers
- Other recursive `fs.rm` on the share: sharedReadCheckoutService.ts:282,357,437,
  repoCacheEvictionService.ts:337,415, devWorkspaceCleanupService.ts:89

## Plan
Phase 0. Stop the bleeding (small, ship first, no flag):
1. `removeDirectoryAsync`: after rename, delete with a detached child process (`rm -rf <trash>`
   via `child_process.spawn`, not `fs.promises.rm`) so libuv threads are never held. Reuse the
   async git/exec helper pattern in `src/server/utils/asyncGit.ts`.
2. Route every recursive delete under `resolveDataRoot()` through that helper (list above),
   including `fs.rmSync` at runGroundingMaterializer.ts:357.
3. Add a libuv probe to `src/server/services/dbPoolTelemetry.ts`: time `fs.promises.stat('/')`
   and `dns.promises.lookup(<pg host>)` every 30s and emit `runtime.threadpool.probe`.

Phase 1. In-process grounding on local disk (flag on):
4. Add `resolveLocalGroundingRoot()` (default `os.tmpdir()/apex-grounding`). Destination becomes
   `<localRoot>/<digest>` when the run executes in the App Service process.
5. Clone from the share mirror into local disk (`git clone --reference <mirror> --dissociate`):
   SMB reads are sequential pack reads, and file creates/deletes stay local.
6. Local eviction: wipe `<localRoot>` at startup and cap by size (LRU by mtime) in
   `groundingEvictionService`. Skip active digests.

Phase 2. Cross-process runs (worker Job, interactive host):
7. Carry grounding identity (provider/project/repo/sha) in the execution spec instead of a share
   path. The consumer materializes onto its own local disk from the Blob bundle
   (`bundleStoreService.rehydrate`) or its mirror. App Service only publishes the bundle.
8. Keep the share path as a fallback behind the flag until two stable sprints, then remove it.

## Done
- [x] Root cause found on prod (see Why).
- [x] Phase 0 on branch `fix/grounding-delete-off-threadpool` (off origin/main, uncommitted):
  `src/server/utils/removeTree.ts` (`rm -rf` child process; `fs.promises.rm` on win32) used by
  repoWorkspaceService, runGroundingMaterializer (replaced `fs.rmSync`), sharedReadCheckoutService,
  groundingEvictionService, repoCacheEvictionService, devWorkspaceCleanupService, bundleCheckout,
  bundleStoreService (share destinations only; local scratch dirs unchanged).
  `dbPoolTelemetry.ts` emits `runtime.threadpool.probe` {waitMs, pending} every 30s.
  Tests: removeTree.test.ts (new), dbPoolTelemetry, repoCheckoutService updated. 13 suites green, tsc clean.

## Next
1. Commit, open the PR, deploy. Then watch `runtime.threadpool.probe` waitMs and pg timeouts per host.
2. Replan: V2 cutover moves all repo work to the repo-read container (Blob + local disk).
   App Service sends only repo/branch/sha. Phase 1 "local disk in App Service" is dropped.
3. Not covered by Phase 0: interactiveActorHost (groundedRepositoryCheckout,
   interactiveWorkspaceMaterializer) and aiRunsV2Worker deletes. Those run in containers, not App Service.

## Mistakes to avoid (learned in earlier chats)
- Don't replace `fs.rmSync` with `fs.promises.rm` on the share and call it non-blocking: it moves
  the stall onto the 4 libuv threads, which DNS and new pg connects need too.
- Git Bash on Windows: set `MSYS_NO_PATHCONV=1` for `az` resource IDs, but unset it for
  `curl -o /tmp/...`, or the downloads silently fail.
- `az monitor app-insights query` defaults to the last 1h. Pass `--offset 30h` or similar.
- Kudu `/api/command` runs in the Kudu container and can't see the app process. To inspect it,
  SSH from Kudu into the app container with `/opt/webssh/node_modules/ssh2`: host from
  `/appsvctmp/ipaddr_$WEBSITE_ROLE_INSTANCE_ID`, port 2222, `WEBSITE_SSH_USER/PASSWORD`.
  Send scripts base64-encoded, because Kudu's command parser breaks on quotes.
- Container logs rotate (`*_default_docker.1.log`, `.2.log`). Fetch all parts.
- Prod instance names differ by view: App Insights/Kudu use a 64-hex ID, while the portal restart
  tool and logs use the host name (e.g. `ln0sdlwk00139J`). Map them via `printenv COMPUTERNAME` in Kudu.

## Verify with
- `npx jest src/server/__tests__/repoWorkspaceService.test.ts src/server/__tests__/runGroundingMaterializer.test.ts src/server/__tests__/groundingEvictionService.test.ts src/server/__tests__/repoCheckoutService.test.ts`
- `npx tsc -p tsconfig.server.json --noEmit`
- Prod: count `due to connection timeout` per host in today's container logs. libuv states via
  `/proc/<node pid>/task/*/{comm,stat,wchan,syscall}` over the SSH bridge.

## Open questions for the user
- Do cross-process consumers (worker Job, interactive host) need App Service's checkout, or can
  each materialize its own copy from Blob (Phase 2)?
- Local disk cap for grounding per instance? (40G free today; suggest 15G.)
- Should repo-cache mirrors also move local (3 instances × 3 repos = 3x fetch traffic), or stay
  on the share as read-only clone sources?
- Ship Phase 0 alone first (recommended), or together with Phase 1?
