# FEAT-002 Build Access and Gating
Updated: 2026-10-23. Repo: Apex. Branch: feature/feat-002-build-access-gating (from main @ a903b17e)

## Goal
Implement FEAT-002 per `.ai-pilot/local-dev/feat-002/` (prd, backlog, design-spec trio) via `/dev-orchestrator feature feat-002 FEAT-002`.
Items: TBI-004 (perm keys, menu key, flag, allow-list store), PBI-002 (Platform Admin allow-list), PBI-003 (Builds menu/route gate).

## Constraints & decisions
- No git commit/push. Protected files untouched (index.ts, package.json, tsconfig*, jest.config*, CI).
- Operator: allow BOTH ado and github repos on the allow-list (overrides spec's ADO-only default).
- Operator: stale allow-list entries stay when a repo row is deleted/renamed; no projectSettingsService change.
- Suspend reason for pair removal = `configuration` (FEAT-001 merged vocabulary has no `pair_removed`); FEAT-010 owns suspend.
- Migrations renamed to sort after FEAT-001 (`20261023144000`): `20261023200000_b7e2_…`, `…200100_b7e3_…`, `…200200_b7e4_…`.
- Flag-off refusal = 403 `{ error, code: 'BUILD_FLAG_DISABLED' }`; read guard has no flag check.
- Implemented directly (single writer), not via subagents.

## Key files
- src/shared/types/buildAccess.ts: constants, DTOs, refusal codes/messages
- src/server/services/buildAccessService.ts: flag helpers, isBuildPairAllowed (no cache), list/add/remove + audit tx
- src/server/middleware/buildAccess.ts: requireBuildFlag, requireAllowlistedPair, buildRead/Run/ActionGuard
- src/server/routes/platformAdmin.ts: "Build allow-list" section (4 routes)
- Pattern: DevEnvAllowlistPanel.tsx, LoadTestsRouteGuard.tsx, utils/canAccessMyWork.ts

## Done
- [x] S1 shared types; featureFlags BUILD_FROM_PROMPT_FLAG; menuSettings `builds` opt-in; restrictedAccess MODULE_VIEW_PERMISSIONS
- [x] S2 permission + flag migrations; rbac-governance.mdc rows
- [x] S3 allow-list migration; schema.ts buildAllowlist/buildAllowlistAudit
- [x] S4 service + tests (buildAccessService.test.ts)
- [x] S5 middleware + tests (buildAccessMiddleware.test.ts)
- [x] S6 routes + tests (platformAdminRoutes.test.ts)
- [x] migration content tests (buildAccessMigrations.test.ts)

- [x] S7 hooks, BuildAllowlistPanel (+test), Builds tab in PlatformAdmin.tsx
- [x] S8 canAccessBuilds, BuildsRouteGuard (props-based, no fetch), BuildsView + CSS (+tests)
- [x] S9 AppHeader/AppSidebar/App.tsx wiring (+VT-06 tests)
- [x] S10 menuSettings.test (16), diagramRbacNavigation.test (minus builds), walkthrough module count 18→19 (+ builds entry in walkthroughPageModuleScope.ts)
- [x] S11 tests/e2e/specs/builds-access-gating.spec.ts — ran locally, 3 passed
- [x] Final gate: both tsc clean, impacted jest green, data-testid exit 0, eslint 0 errors
- [x] S12 tests/integration/build-access.integration.test.ts — VT-12, VT-15, VT-16; 7 passed against aipilot_e2e

## Next
1. Operator: review diff, commit/push, open PR to dev

## Mistakes to avoid
- Glob skips .ai-pilot (gitignored); use shell `find`.
- Migration SQL has CRLF on Windows; tests must use `\s` not `\n`.
- schema.ts uses object-style table extras `(t) => ({ … })`, not arrays.
- New MenuItemKey breaks Record<MenuItemKey> maps (restrictedAccess.ts, walkthroughPageModuleScope.ts) — tsc finds them.
- check-data-testid reads the git index only: stage, run, then `git reset -q -- <files>`.
- jest paths from rg on Windows have backslashes and silently don't match — use forward slashes.

## Verify with
- `npx jest --selectProjects server --no-coverage -- src/server/__tests__/buildAccess*.test.ts src/server/__tests__/platformAdminRoutes.test.ts`
- `npx tsc -p tsconfig.server.json --noEmit` / `npx tsc -p tsconfig.client.json --noEmit`
- `npx dotenv -e .env -- npx cross-env NODE_OPTIONS=--experimental-vm-modules jest --config jest.config.integration.js tests/integration/build-access.integration.test.ts`
- `npx prettier --check` fails repo-wide on Windows (CRLF via core.autocrlf); CI runs only `lint:check` (ESLint), so ignore it.

## Open questions for the user
- none
