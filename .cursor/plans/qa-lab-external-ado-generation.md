# QA Lab external ADO generation
Updated: 2026-10-10. Repo: Apex. Branch: feat/qa-test-case-workbench

## Goal
Generate QA test cases from any ADO PBI or Bug, including items created outside Apex. Features/Epics roll up descendant PBIs. Store durable reviewable suites in Apex and publish selected cases as linked ADO Test Case work items.

## Constraints & decisions
- Keep existing PRD-backed suites working.
- PBIs and Bugs own cases; TBIs provide context only.
- External suites use a new table instead of fake/hidden PRDs.
- Publishing is explicit and idempotent; do not silently create duplicate ADO Test Cases.
- ADO writes use the logged-in user's token in production.

## Key files
- src/server/services/testCaseService.ts: PRD-backed generation and output watcher.
- src/server/services/testCaseLookupService.ts: resolve ADO ids stamped into Apex backlogs.
- src/server/services/azureDevOps.ts: ADO reads and Test Case creation.
- src/server/routes/interviews.ts: QA Lab routes.
- src/client/components/QaLabView.tsx: picker, generation, and publishing UI.
- src/server/db/schema.ts: add external suite storage.
- migrations/: add external suite table.
- Pattern: src/server/services/calendarWorkItemAssistantService.ts

## Done
- [x] QA Lab loads the whole selected ADO project and filters by type/state/search.
- [x] PRD-backed selected items can run scoped generation without replacing other PBI suites.
- [x] Existing changes pass focused lookup/service tests and client/server typechecks.
- [x] Added retained external-suite schema and migration.
- [x] Added ADO-native hierarchy context for PBIs/Bugs with TBI context.
- [x] Added Generate and explicit Publish-to-ADO UI states.
- [x] Added external generation worker/watcher using the project test-case skill.
- [x] Added retry-safe publishing as native ADO Test Case work items with Tested By links.
- [x] Focused service tests, route regression tests, typechecks, and lint pass.

## Next
1. Commit and push the completed change.
2. Deploy with migrations enabled.
3. In dev, generate from an ADO-native PBI and publish the ready suite.

## Mistakes to avoid
- Do not reuse calendar work-item queries; they filter by month and exact area path.
- Do not create fake PRDs for ADO-native items.
- Do not overwrite suites for unrelated PBIs during scoped regeneration.
- Do not treat TBIs as direct test-case owners; the skill is PBI-oriented.
- Do not auto-publish generated cases to ADO before review.

## Verify with
- `npx jest src/server/__tests__/testCaseLookupService.test.ts src/server/__tests__/testCaseService.test.ts --silent`
- `npx tsc -p tsconfig.client.json --noEmit`
- `npx tsc -p tsconfig.server.json --noEmit`
- `ESLINT_USE_FLAT_CONFIG=false npx eslint <changed files> --ext .ts,.tsx`

## Open questions for the user
- None; user approved storage migration and ADO publishing.
