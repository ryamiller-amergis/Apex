# Guided interview on interactive V2
Updated: 2026-10-12. Repo: Apex. Branch: labs/interview-playbook

## Goal
When `ai-runs-v2-transport` and `playbook-interview-step` are both on, guided (`grill-with-docs`) interview turns run on durable V2 with the same controlled prompt, application brief, per-phase repository tools, and reply markers as the in-process path.

## Constraints & decisions
- Guided-on-V2 is gated by `playbook-interview-step` (why: without it, V2 grill-with-docs interviews keep today's open-ended prompt).
- App Service resolves the turn; the spec carries `guidedInterview { phase, turn }` (why: `.cursor/rules/v2-worker-no-policy.mdc`).
- `guidedInterview` is optional on the spec (why: specs admitted before this change stay valid).
- App Service V2 graph must not import `@cursor/sdk` (enforced by `interactiveV2NoFallback.test.ts`), so prompt helpers live in `guidedInterviewState.ts`.
- Old V1 lane (`ai-runs-interactive`) bypasses guided interviews (`guided-interview`).

## Key files
- src/server/services/durableInteractiveTurnService.ts: `resolveGuidedInterview`, guided prompt in `admit`, product phase drops `ado-skills` and the repository context pack
- src/shared/types/durableInteractiveTurn.ts: `FrozenGuidedInterview`, guard
- src/shared/types/interview.ts: `GuidedInterviewTurn`, `InterviewRepositoryPhase`
- src/server/services/interactiveActorHost/interactiveCursorExecution.ts: tools by `interviewPhase`
- src/server/services/interactiveActorHost/interactiveSessionActor.ts: durable cache key includes phase; reply normalized
- src/server/services/interactiveActorHost/entrypoint.ts: passes `guidedInterview?.phase`
- src/server/services/chatAgentService.ts: V1 bypass in `tryDispatchInteractiveTurn`

## Done
- [x] App Service guided spec, worker tools/normalization, V1 bypass, tests

## Next
1. Push to dev; enable both flags for one project.
2. Run a Playbook interview: first reply starts with `[[interview-phase:discovery:1:6]]`, no repo tool calls in Discovery/Delivery.
3. Choose Technical: agent rebuilt once, `get_skill_file` works, search closed.
4. Turn `playbook-interview-step` off: V2 interview prompt unchanged from before.

## Mistakes to avoid (learned in earlier chats)
- main was merged mid-task and replaced the V2 router (`ai-runs-v2-transport` → `durableInteractiveTurnService`), so re-read `interactiveWorkflowRouter.ts` before trusting earlier notes.
- Importing `interviewGroundingPolicy` from App Service V2 code pulls in `@cursor/sdk` and fails `interactiveV2NoFallback.test.ts`.

## Verify with
- `npx jest src/server/__tests__/durableInteractiveTurnPrompt.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/interactiveV2NoFallback.test.ts`
- `npx tsc -p tsconfig.server.json --noEmit`

## Open questions for the user
- In-process guided interviews are not gated by `playbook-interview-step`; gate them too?
- Pre-existing failures on this branch: foundationSkillLinkedContextParity, groundingBundleStoreService, interviewLinkRoutes, playbookPermissionRecheck, repoReader.
