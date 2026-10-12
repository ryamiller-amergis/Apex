# QA Lab: scope picker, Manual/E2E split, manual coverage
Updated: 2026-10-12. Repo: Apex. Branch: feat/qa-test-case-workbench

## Goal
Phase 1: QA chooses which PBIs/Bugs get cases before generating; QA Lab separates Manual, E2E, and other automated cases; manual coverage per PBI is visible; create-test-case skill demands thorough manual scripts.
Phase 2 (design only, later): Playwright playground inside Apex to run E2E cases.

## Constraints & decisions
- Picker default: PBI/Bug selected -> only itself checked; Feature/Epic -> all children checked (why: user saw unexpected child PBIs).
- E2E cases stay tagged step lists in Phase 1, no generated scripts (user choice).
- Tab grouping uses existing `automationTier`: `manual` or missing -> Manual; `e2e-playwright` -> E2E; `unit`/`integration` -> Automated.
- Skill edit: Apex copy only; report the diff for MaxView repo (`development` branch) to copy manually.
- Do not commit unless asked. Exclude `docs/superpowers/plans/Apex-ATS-Integration.code-workspace`.

## Key files
- src/shared/types/qaLab.ts: request/target types.
- src/server/services/testCaseLookupService.ts:75-115: backlog match, add PBI titles.
- src/server/services/adoTestCaseSuiteService.ts:273-310: trigger; add targetIds filter + candidates reader.
- src/server/routes/interviews.ts:442-488: generate route; add candidates GET.
- src/client/hooks/useQaLab.ts, src/client/components/QaLabView.tsx(+ .module.css).
- .cursor/skills/create-test-case/SKILL.md: manual coverage rules.

## Done
- [x] Types: pbiTargets, QaLabGenerationCandidates, targetIds (src/shared/types/qaLab.ts).
- [x] Lookup returns pbiTargets (testCaseLookupService.ts).
- [x] `listAdoGenerationCandidates` + `targetIds` narrowing (adoTestCaseSuiteService.ts); GET `/work-items/:id/test-cases/candidates`; POST validates targetIds (interviews.ts).
- [x] UI scope picker, Manual/E2E/Automated tabs, manual coverage strip (QaLabView.tsx/.module.css).
- [x] Skill: "Manual execution coverage" section + checklist items (.cursor/skills/create-test-case/SKILL.md).
- [x] Focused jest, tsc client/server, eslint all green.

## Next
1. User reviews in dev; copy skill section into MaxView repo `development` branch.
2. Phase 2: write design for Playwright playground (answers to open questions first).

## Mistakes to avoid (learned in earlier chats)
- Generate must not await worker prep in the HTTP request (Azure ~230s timeout).
- Worker harvest output arrives via syncOutputToDb with a temp workspace; ADO suites hook `syncAdoTestSuiteRunOutput`.
- Interview route tests expect PRD trigger called with 4 args unless scope is set.

## Verify with
- `npx jest src/server/__tests__/adoTestCaseSuiteService.test.ts src/server/__tests__/testCaseLookupService.test.ts src/server/__tests__/interviewRoutes.test.ts --runInBand --silent`
- `npx tsc --noEmit -p tsconfig.client.json && npx tsc --noEmit -p tsconfig.server.json`
- `ESLINT_USE_FLAT_CONFIG=false npx eslint <files> --ext .ts,.tsx --quiet`

## Open questions for the user
- Phase 2 playground: where the browser runs, which sites it may open, how it signs in.
