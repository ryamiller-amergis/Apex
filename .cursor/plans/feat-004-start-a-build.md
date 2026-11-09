# FEAT-004 Start a Build
Updated: 2026-10-26. Repo: Apex. Branch: `feature/feat-004-start-a-build` (off origin/main, upstream unset). Do not commit or push unless asked.

## Goal
A person with `builds:run` and `playbooks:run` can start a build from `/builds/new`. The start is idempotent, refuses when the flag, allow-list, or preflight fails, queues past 3 per project or 10 platform-wide, and parks a `build` Playbook step. The list and Agent Home pill show in-progress work.

## Constraints & decisions
- Assumptions U1–U9 accepted. Queued rows have `playbook_run_id` null until promotion. Slot statuses: intake, planning, building, checking, deploying.
- Flag `build-from-prompt`. Preflight refusal is 409 `BUILD_PREFLIGHT_REFUSED` (not 422). Prompt never stored in events.
- Model override writes `model_override` and applies to all five skill-snapshot roles. Live column names stay (`requested_by_user_id`, `playbook_step_run_id`).
- `src/server/index.ts` may only change for the `/api/builds` mount and the queue scheduler. Do not edit package.json, tsconfig, vite, jest, or CI.
- Jest: `npx jest --selectProjects server|client --no-coverage -- <files>`. No `--testPathPattern`, no `--runInBand`.

## Key files
- `src/server/services/buildOrchestrator/startBuild.ts`: start order and HTTP error mapping
- `src/server/services/buildOrchestrator/admission.ts`: caps and promotion decisions
- `src/server/services/playbookSteps/buildAdapter.ts`: parks the step and calls `beginPlanning`
- `src/server/playbookTemplates/build-from-prompt.json`: interview then build
- `migrations/20261026210000_f4b1_build-start-queue.sql`: nullable playbook run, `queued_at`, `skill_settings_id`, one-time link
- `src/client/components/NewBuildForm.tsx`, `BuildsListView.tsx`, `BuildAgentHomePill.tsx`
- `src/client/App.tsx` around the builds branch: `/builds/new` renders the form

## Done
- [x] Start, list, repositories routes, admission, promotion, scheduler, template, build step
- [x] List, form, and Agent Home pill wired; FEAT-002 access tests updated to the new test ids
- [x] Server and client typecheck clean
- [x] Targeted Jest for the new suites and the registry/interview/palette/composer tests
- [x] data-testid check on the touched client components
- [x] Integration: `build-start`, `build-orchestrator` (VT-07, VT-12, VT-21, VT-34), `build-schema` all pass; migration down/up clean
- [x] E2E: `build-start.spec.ts` and `builds-access-gating.spec.ts` pass (5 tests, including the axe scan)
- [x] Queued replay reports the live queue reason; promotion suspends a build whose settings link was cleared
- [x] Full Jest run: only failures were git-heavy suites that time out under load; all pass alone except `repoCacheGitIntegration` (5s timeout, untouched by this branch)
- [x] `npm run lint:check` passes (0 errors)

## Next
1. Feature work is complete. Commit or open a PR only when the user asks.
2. Do not commit the unrelated untracked plans or `docs/APEX_SKILLS_SERVICE_TEMPLATE.md`.

## Mistakes to avoid
- `Object.assign` copies getter values once. Counters in tests must be a mutable object, not a getter.
- `PlaybookGuardViolationError` takes `(kind, message)`.
- The registry step-type list must be alphabetical (`build` before `cursor-agent`).
- Jest's `crypto.randomUUID` is missing. `NewBuildForm` falls back when it is absent.
- A second update of `playbook_run_id` to the same value does not trip the frozen trigger. The integration test must use a different run id.
- Do not add events to the pinned `BUILD_EVENT_TYPES` array. The writer checks the dotted pattern only.
- Promotion and admission writes must use the transaction executor, not the global `db`. `startRun` stays outside the transaction.
- The Playwright webServer times out at 60s (slow ts-node compile). Start the API and Vite servers by hand with the env from `playwright.config.ts`; Playwright reuses them. Do not edit the config. Kill the servers afterwards (check ports 3000 and 3001).
- `fk_build_runs_skill_settings` is `ON DELETE SET NULL` on purpose; `build-schema.integration.test.ts` allows it.
- New build step types need a config fixture in `playbookPermissionRecheck.test.ts`; new build indexes or checks must be read by `buildSchemaParity.test.ts`.

## Verify with
- `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`
- `npx jest --selectProjects server --no-coverage -- src/server/__tests__/buildStartService.test.ts src/server/__tests__/buildAdmission.test.ts src/server/__tests__/playbookBuildAdapter.test.ts src/server/__tests__/playbookBuildTemplate.test.ts src/server/__tests__/buildStartRoute.test.ts src/server/__tests__/playbookStepRegistry.test.ts`
- `npx jest --selectProjects client --no-coverage -- src/client/components/__tests__/NewBuildForm.test.tsx src/client/components/__tests__/BuildsListView.test.tsx src/client/components/__tests__/BuildAgentHomePill.test.tsx src/client/components/__tests__/BuildsView.test.tsx`

## Open questions for the user
- None. U1–U9 defaults were accepted, and `src/server/index.ts` was approved for the mount and scheduler only.
