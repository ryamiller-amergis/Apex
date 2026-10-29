# FEAT-006 — Brief Approval and Risk Decisions
Updated: 2026-10-27. Repo: Apex. Branch: `feature/feat-006-brief-approval-risk-decisions` (off origin/main 32c3f5da, FEAT-005 merged). No commit/push.
Context pack: `.ai-pilot/local-dev/feat-006/` (TBI-010, TBI-011, PBI-011, PBI-012, PBI-013; design-spec trio; no test-cases.json).

## Operator decisions
- U1–U7 accepted as proposed in the design assumptions.

## Naming resolved against repo
- Profile key `BUILD_INTAKE_OPTION_KEY` (`src/shared/types/buildPreflight.ts`). Predicate already exists: `isBuildIntakeParticipant` in `threadAccessService.ts` → moved to new `src/server/services/buildIntakeAccess.ts` (`canActOnBuildIntakeInterview`), old name delegates.
- Ready trigger: requester's reply to a `[[build-intake:confirm]]` agent message (`Answer: A — Confirm`, from `formatChoiceAnswers`). Hooked in `src/server/routes/chat.ts` build-intake branch (no server turn-end hook exists).
- Events: `intake.brief_drafted`, `intake.brief_edited`, `intake.brief_approved`, `intake.brief_draft_failed` via `appendBuildEvent` (dedupe on run+dedupeKey).
- Counters / estimate / needsMigration / reasons: stored in the `detail` JSON of the latest drafted/edited event (no text). `reversible` optional on `BuildRiskDecision`.
- Flag: `isBuildFromPromptEnabled` (`buildAccessService.ts`).

## Steps
- [x] S1 shared types + `buildRiskClassifier.ts` + tests
- [x] S2 `buildIntakeAccess.ts`, thread rule, `middleware/buildIntakeBrief.ts`, approve branch, PRD 409
- [x] S3 `draftBuildIntakeBrief` in orchestrator
- [x] S4 `buildBriefService.ts`, `beforeResume` + `alreadyApproved`
- [x] S5 routes wiring + chat auto-draft (`isBuildIntakeConfirmation` → `prepareBuildIntakeTurn().confirmed` → `autoDraftBuildBriefForThread` after `sendMessage`); tests in `buildBriefRoutes.test.ts`, `chatRoutes.buildIntake.test.ts`
- [x] S6 `useBuildBrief.ts` (analysis 404 → `{kind:'missing', draftFailed}`; both queries poll 5s until a draft exists)
- [x] S7 six components + CSS; tests `BuildBriefReview.test.tsx`, `BuildRiskDecisions.test.tsx`
- [x] S8 `InterviewChatView` renders `BuildBriefReview` when build-intake; VT-27 in `InterviewChatView.BuildIntake.test.tsx`
- [x] S9 `tests/e2e/specs/build-brief-approval.spec.ts` authored (stubbed brief APIs); execution deferred — no Playwright env
- [x] F6: both tsc clean; eslint adds no warnings vs main; check-data-testid passes; full jest 10098 pass, 4 unrelated git/repo suites fail under full-suite load only (pass alone)

## Status
Done. Not committed. Next: run the Playwright spec where an env exists; FEAT-008 mounts `BuildRequirementList` / `BuildRiskDecisions` on `/builds/:id`.

## Mistakes to avoid
- Picker replies are `Q1 · <question>\nAnswer: A — <option>`, not just `Answer: A` — match per line.
- `interviewLinkRoutes.test.ts` counts `requireGroupMembership('BA','Manager','Product-Owner')` calls at registration (expects 4) — each brief route builds its own guard.
- `src/shared/utils/__tests__` is not in a Jest project → shared util tests go in `src/server/__tests__`.
- `interviewRoutes.test.ts` mocks `rbacHelpers` with only `isAdminUser`; new code must not call other helpers for non-build interviews.

## Verify with
- `npx jest --selectProjects server --no-coverage -- <files>`
- `npx tsc -p tsconfig.server.json --noEmit` / `tsconfig.client.json`
