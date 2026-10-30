# FEAT-010 — App Builder v1 Task Dispatcher

Branch: `feature/feat-010-task-dispatcher` (from `origin/main` 6d2918e9). No commit / push.
Context pack: `.ai-pilot/local-dev/feat-010/`. Skill: dev-orchestrator (local mode).

## Operator decisions (assumption gate)
- Chains: use the planner's saved `build_tasks.chain_head_key` (not graph derivation).
- Task failure (launch failure, failed agent, finished without evidence) consumes one revision repair attempt; none left → suspend `repair_cap`.
- Parallelism cap: excess units wait as `ready`; never suspends.
- Flag off = `isFeatureOperational` false OR `isFeatureEnabled` false for requester+project.
- Task branch: `taskBranchName(runId, headKey)` + `-<attempt>`; attempt +1 on every relaunch.
- FEAT-011/012/016 pieces are ports with fakes; production candidate builder refuses → run suspends `configuration`.
- Allowed to add the start call in `src/server/index.ts`.

## Live-repo naming resolved
- Event dedupe: `build_events.dedupe_key` (`uq_build_events_dedupe`) via `appendBuildEvent`.
- Event names dotted: `task.launched`, `task.launch_deferred`, `task.completed`, `task.failed`, `task.requeued`, `task.completion_discarded`, `agent.cancel_failed`, `run.suspended`.
- `cap_reached` → `repair_cap`. `agent_runs.build_task_id` index and My Work pump isolation already on main.

## Files (src/server/services/buildOrchestrator/)
- `dispatcher.ts` pure selector (S1) · `launchGuard.ts` (S2) · `dispatchStore.ts` + `dispatchEvents.ts` (S3)
- `taskFailure.ts`, `taskLauncher.ts`, `dispatchRun.ts` (S4) · `applyCompletion.ts` (S5) · `reconcile.ts` (S6)
- `dispatchWiring.ts` + `index.ts` exports · `src/server/services/buildReconciliationScheduler.ts` + index.ts start (S7)

## Tests
- `src/server/__tests__/buildDispatcher.test.ts`, `buildDispatchLaunchGuard.test.ts`, `buildDispatchFlow.test.ts`, `buildReconciliationScheduler.test.ts`, `buildFlagRouteAccess.test.ts`
- `tests/integration/build-dispatch.integration.test.ts` (VT-10, 15, 16, 17, 19)

## Status
- [x] S1–S9 done. tsc server clean; 120 related unit tests pass; 6 integration tests pass on local Postgres; ESLint 0 errors; codemap check OK.
- Not committed or pushed.

## Open follow-ups (other features)
- FEAT-011: call `registerBuildDispatchPorts({ buildCandidate, mayReportDone })`. Until then every launch suspends the run with `configuration`.
- FEAT-012: register `requestMerge`; call `dispatchNext(runId)` right after a task merges. The default repair counter uses `build_revisions.repair_attempts` (cap 2).
- FEAT-016: resume moves `suspended` → `building`, then calls `dispatchNext`. End-to-end proof of PBI-021 AC-2 belongs there.
