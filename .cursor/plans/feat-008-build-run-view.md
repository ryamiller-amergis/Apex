# FEAT-008 Build Run View
Updated: 2026-10-28. Repo: Apex. Branch: feature/feat-008-build-run-view (off origin/main 17de93d0)

## Goal
`/builds/:buildId/:tab?` page (Overview, Plan, Timeline) + `GET /api/builds/:id` and `/:id/events`.
Contracts: `.ai-pilot/local-dev/feat-008/` (backlog TBI-014, TBI-015, PBI-016..018; design-spec trio). VT-01..VT-35 in tech-spec.

## Constraints & decisions (operator-confirmed 2026-10-28)
- Cross-project build -> 403 `{ error: 'Forbidden' }`; no project -> 404.
- No action buttons; header has empty `actions` slot (Epic 2).
- Flag off: `/builds/:id/*` readable with banner; list stays hidden.
- Timing fallback: elapsed from revision.created_at, `includesDeployment: true`. No migration.
- Overview always null -> "Overview not available." No migration.
- `useBuildIntake` + `BuildIntakeChatRoute` take project, read `build.intakeInterviewId`.
- Live repo naming: hook list = `useBuilds` (keep); events map event_type->kind, detail.taskKey->taskKey, order by ordinal; support contacts drop userId; suspend reasons cost_cap/elapsed_cap/repair_cap/... (7).
- Reuse `BuildRiskDecisions` (FEAT-006). Do NOT reuse `BuildRequirementList` (hides retired rows; BR-013).
- No commit/push. Protected files untouched.

## Key files
- src/server/routes/builds.ts (add GET /:id, /:id/events)
- src/server/services/buildRunProjectionService.ts, buildStageDerivation.ts (new)
- src/shared/types/buildView.ts (new)
- src/client/hooks/useBuilds.ts (extend)
- src/client/components/BuildRunView*.tsx etc. (new); App.tsx builds branch ~L1533
- Pattern: src/server/__tests__/buildStartRoute.test.ts (route mocks)

## Done
- [x] F0/F0.5 gate, branch created
- [x] S1 src/shared/types/buildView.ts
- [x] S2 buildStageDerivation.ts + test (23 pass)
- [x] S3 buildRunProjectionService.ts + test (15 pass; injectable deps; fn named listBuildRunEvents to avoid clash with buildEventsService.listBuildEvents)
- [x] S4 builds.ts GET /:id, /:id/events + buildRunRoutes.test.ts (12 pass); server tsc clean
- [x] S5 useBuilds.ts extended + hooks/__tests__/useBuilds.detail.test.ts (13) + useBuilds.staleData.test.ts (VT-16, own file)
- [x] BuildIntakeChatRoute takes project; App.tsx call site updated
- [x] S6 buildStatusFormat.ts, buildPlanGrouping.ts, buildRunTabList.ts + buildRunHelpers.test.ts (22)
- [x] S7-S10 BuildRunHeader/Tabs/SuspensionNotice/Overview/Plan/Timeline + BuildRunView + App.tsx route; BuildRunView.test.tsx (23)
- [x] S11 tests/e2e/specs/build-run-view.spec.ts (stubs API like other build specs; e2eSetup.ts untouched): 2 pass
- [x] F6: both tsc clean; 12 Jest suites 130 pass; data-testid check pass; eslint clean on touched files (1 old App.tsx L173 warning)

## Next
- Nothing. Not committed. Client TSX are staged (data-testid check needs it). CHANGELOG not updated (earlier build features had none).

## Mistakes to avoid
- Context pack is gitignored: Glob misses it; use shell `ls`.
- RTL waitFor under jest fake timers only advances ~1s total. Step fake time 1 s at a time until the state appears; one big jump skips TanStack retries.
- `buildRunTabs.ts` vs `BuildRunTabs.tsx` collides on Windows (TS1149); helper is `buildRunTabList.ts`.
- `useBuilds.test.tsx` already exists; new hook tests are `useBuilds.detail.test.ts`.
- Switch on a local `const key = stage.key`, else the `never` check narrows `stage` badly.
- data-testid checker flags components named `*Tab`; panel bodies carry `// data-testid-exempt`.

## Verify with
- `npx jest --selectProjects server --no-coverage -- <files>`
- `npx jest --selectProjects client --no-coverage -- <files>`
- `npx tsc -p tsconfig.server.json --noEmit`; `npx tsc -p tsconfig.client.json --noEmit`
- `node scripts/check-data-testid.mjs` (after git add of client TSX)

## Open questions for the user
- none
