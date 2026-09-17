# Watcher Safety Report

- Status: DONE_WITH_CONCERNS

## Files changed

- `src/server/services/designDocService.ts`
- `src/server/services/agentRunReaperService.ts`
- `src/server/services/repoCacheLeaseService.ts`
- `src/server/services/startupRecovery.ts`
- `src/server/__tests__/designDocService.test.ts`
- `src/server/__tests__/agentRunReaperService.test.ts`
- `src/server/__tests__/repoCacheLeaseService.test.ts`
- `src/server/__tests__/startupRecovery.test.ts`

## Tests added and observed RED failures

- Added watcher lease-owner coverage in `designDocService.test.ts` for single-owner start, non-holder no-op, lease-loss stop, non-overlapping ticks, single consolidated run-state read, rejected run-state reads, and bounded backoff reset.
- Added consolidated snapshot coverage in `agentRunReaperService.test.ts` for queued budget pause and orphan-grace takeover facts from one query.
- Added non-blocking lease acquisition coverage in `repoCacheLeaseService.test.ts`.
- Added recovery coverage in `startupRecovery.test.ts` for count/logging only when the async watcher seam actually acquires and starts.

Observed RED failures before implementation:

- `TypeError: processA.tryStartSingleFeatureDocWatcher is not a function`
- `TypeError: (0 , designDocService_1.tryStartSingleFeatureDocWatcher) is not a function`
- `TypeError: (0 , agentRunReaperService_1.getThreadRunStateSnapshot) is not a function`
- `TypeError: (0 , repoCacheLeaseService_1.tryAcquireRepoCacheLease) is not a function`

## Implementation summary

- Added a non-blocking held-lease helper in `repoCacheLeaseService.ts` so a single-feature watcher can acquire, renew, observe lease loss, and release a `repo_cache_leases` row without blocking.
- Added `getThreadRunStateSnapshot()` in `agentRunReaperService.ts` to load latest-run facts, budget-charge state, cross-instance liveness, and failure-finalization eligibility in one query.
- Reworked the single-feature design doc watcher in `designDocService.ts` to use the new async start seam, cluster-wide lease ownership, process-local pending-start guard, non-overlapping async ticks, caught tick failures, and bounded 5/10/20/30 second backoff with reset on success.
- Updated `startupRecovery.ts` to adopt generating design-doc watchers through the async seam and only count/log recovery after the watcher actually acquires and starts.

## Exact verification command and result

```text
npx jest src/server/__tests__/repoCacheLeaseService.test.ts src/server/__tests__/agentRunReaperService.test.ts src/server/__tests__/designDocService.test.ts src/server/__tests__/startupRecovery.test.ts --runInBand
```

Result:

- PASS
- Test Suites: 4 passed, 4 total
- Tests: 209 passed, 209 total
- Lint diagnostics: no errors on all changed TypeScript files

## Commit SHA

- `f0c37a2a8a9ab95a72a1e535def8f61565bbbfae`

## Self-review concerns

- An unrelated untracked file was present in the worktree and was left untouched: `migrations/20260917164316_98d8_reassign-design-doc-owner-ryan-miller.sql`.
- The scoped Jest run still emits existing workspace warnings/noise (`jest-haste-map` duplicate manual mock warnings and `aiCompletionNotifier` console errors), but the required suites pass and no new lint errors were introduced.

## Review Fix Appendendum

- Status: DONE_WITH_CONCERNS

### Fix files changed

- `src/server/services/designDocService.ts`
- `src/server/services/agentRunReaperService.ts`
- `src/server/services/repoCacheLeaseService.ts`
- `src/server/__tests__/designDocService.test.ts`
- `src/server/__tests__/agentRunReaperService.test.ts`
- `src/server/__tests__/repoCacheLeaseService.test.ts`

### Tests added and observed RED failures

- Added direct lease tests for renewal stop-on-loss and bounded renewal timeout in `repoCacheLeaseService.test.ts`.
- Added direct watcher tests for hydration rejection cleanup, pre-finalization lease fencing, pre-query output capture, downstream-failure backoff, and stale replacement closure fencing in `designDocService.test.ts`.
- Tightened `agentRunReaperService.test.ts` to verify `getThreadRunStateSnapshot()` performs one database read with no chat-thread fallback query.

Observed RED failures before the follow-up implementation:

- `Expected number of calls: 0 / Received number of calls: 1` for `chatThreads.findFirst` during `getThreadRunStateSnapshot()`
- `Expected number of calls: 1 / Received number of calls: 7` for lease renewals after ownership loss
- `Received: undefined` for captured output after a run-state lookup failure
- `Expected: true / Received: false` for stale replacement watcher survival
- `Expected number of calls: 2 / Received number of calls: 4` for downstream finalization backoff

### Follow-up implementation summary

- Bounded lease renewal attempts in `repoCacheLeaseService.ts`, stopped heartbeats immediately on renewal loss/failure, and made `assertOwned()` fail fast once the lease is already lost.
- Removed the snapshot helper's feature-flag fallback query so `getThreadRunStateSnapshot()` performs exactly one `agent_runs` database read.
- Reworked the single-feature watcher to capture output before run-state reads, schedule ticks with single-shot timers, carry a per-generation local token, and require fresh lease ownership immediately before terminal writes and workspace cleanup.

### Exact verification command and result

```text
npx jest src/server/__tests__/repoCacheLeaseService.test.ts src/server/__tests__/agentRunReaperService.test.ts src/server/__tests__/designDocService.test.ts src/server/__tests__/startupRecovery.test.ts --runInBand
```

Result:

- PASS
- Test Suites: 4 passed, 4 total
- Tests: 217 passed, 217 total
- Lint diagnostics: no errors on all changed TypeScript files

### Fix commit SHA

- `5cd83e8eff5b6d555c87bd319fb373c835bf6b6d`

### Follow-up concerns

- Existing unrelated worktree changes under `.cursor/skills/prod-db-migrate/` were preserved untouched.
- The required Jest suites still emit pre-existing workspace noise (`jest-haste-map` duplicate mock warnings and `aiCompletionNotifier` console errors), but the verification command passed cleanly.

## Re-review Fix Appendendum

- Status: DONE_WITH_CONCERNS

### Fix files changed

- `src/server/services/designDocService.ts`
- `src/server/services/agentRunReaperService.ts`
- `src/server/services/repoCacheLeaseService.ts`
- `src/server/__tests__/designDocService.test.ts`
- `src/server/__tests__/agentRunReaperService.test.ts`
- `src/server/__tests__/repoCacheLeaseService.test.ts`

### Tests added and observed RED failures

- Added lease coverage for `assertOwned()` after release in `repoCacheLeaseService.test.ts`.
- Added watcher coverage for concurrent two-thread starts on one document, timeout thread guarding, and lease-conditioned terminal update wins in `designDocService.test.ts`.
- Added snapshot coverage for the background-worker one-query path and legacy non-worker live-flag fallback in `agentRunReaperService.test.ts`.

Observed RED failures before the re-review implementation:

- `Received promise resolved instead of rejected` for `assertOwned()` after release
- `Expected: ArrayContaining ["thread-deadline"]` from the timeout update guard assertion
- `Expected: false / Received: true` when the guarded terminal update returned no winning row
- `Expected: "thread-1" / Number of calls: 0` for the legacy non-worker feature-flag fallback
- Concurrent two-thread start coverage timed out before the generation handoff was fixed

### Re-review implementation summary

- Made released/stopped lease handles reject `assertOwned()` and exposed held lease identity/generation for downstream fencing.
- Restored the live feature-flag fallback only for legacy non-worker run-state classification while keeping the normal background-worker watcher path to one `agent_runs` query and no feature-flag query.
- Added chat-thread plus lease owner/generation fencing to terminal design-doc writes and timeout failure writes, and required a winning guarded update before cleanup, notifications, or validation kickoff.
- Re-read the active local watcher after async lease acquisition so concurrent starts for different threads can safely hand off the local generation.

### Exact verification command and result

```text
npx jest src/server/__tests__/repoCacheLeaseService.test.ts src/server/__tests__/agentRunReaperService.test.ts src/server/__tests__/designDocService.test.ts src/server/__tests__/startupRecovery.test.ts --runInBand
```

Result:

- PASS
- Test Suites: 4 passed, 4 total
- Tests: 221 passed, 221 total
- Lint diagnostics: no errors on all changed TypeScript files

### Fix commit SHA

- `PENDING_FINAL_COMMIT_SHA`

### Follow-up concerns

- Existing unrelated worktree changes under `.cursor/skills/prod-db-migrate/` were preserved untouched.
- The required Jest suites still emit pre-existing workspace noise (`jest-haste-map` duplicate mock warnings and `aiCompletionNotifier` console errors), but the verification command passed cleanly.
