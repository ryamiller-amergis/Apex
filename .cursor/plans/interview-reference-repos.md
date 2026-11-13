# Interview reference repositories
Updated: 2026-11-13. Repo(s): Apex. Branch: feature/interview-reference-repos. PR: https://github.com/ryamiller-amergis/Apex/pull/290

## Goal
An interview (e.g. amergisconnect-ats) can attach read-only reference repos (MatterWorx, MaxView) from the project's Brainstorm repository catalog. The interview stays grounded on the project repo; on Technical-phase turns the agent can list/read the reference repos under `sources/<catalogRepoId>/...`. No foreign code lands in the ATS repo.

## Constraints & decisions
- Behind flag `interview-reference-repos` (seeded off by migration). Server routes 404 and the turn builder skips lookup when off; client hides the section.
- Reuses Brainstorm infra only: catalog clones (`brainstorm_repositories`), `BrainstormTurnSources` shape, worker mount + multi-root reader. No new clone path.
- Each turn reads the catalog's current commit (latest clone); the frozen spec records the SHA.
- Cap 3 per interview, separate from the 10-item ADR/Design Module cap. Only `ready` catalog rows can be linked.
- Only on V2 durable interactive turns (same requirement as Brainstorm). Legacy in-process chat path (`chatAgentService`) is NOT wired.
- Only Technical phase (and non-guided interviews). Discovery/Delivery close repo tools by design, so no reference sources there.
- Interview Technical policy keeps `search_repo_code` closed; agent uses `list_repo_dir` + `get_skill_file` on `sources/<id>/` paths.
- Worker reads interview roots lazily like Brainstorm (link local mirror, else bare-mirror reader) so a missing repo never fails the turn.
- Permissions reuse `interviews:view` / `interviews:manage`. No RBAC migration.
- Out of scope v1: Brainstorm→Interview handoff carry-over, kickoff (pre-creation) picker, PRD/design-doc grounding, artifactBindingResolver hash.

## Key files
- migrations/20261113154500_a3f1_interview-reference-repositories.sql: link table
- migrations/20261113154600_b7c2_seed-interview-reference-repos-flag.sql: flag seed
- src/server/db/schema.ts: `interviewReferenceRepositories` + relations
- src/shared/types/interviewLinks.ts: flag key, cap, read model, `REPOSITORY_NOT_READY`
- src/shared/types/durableInteractiveTurn.ts: optional `referenceSources` (interview only) + validator
- src/server/services/brainstormRepositoryCatalog.ts: `catalogReadRoot` (shared with brainstormSources.ts)
- src/server/services/interviewLinkService.ts: get/add/remove reference repos, `loadInterviewReferenceSources`, instructions text
- src/server/routes/interviews.ts: `/:interviewId/reference-repositories` GET/POST/DELETE (flag-gated)
- src/server/services/durableInteractiveTurnService.ts: `loadReferenceSources` dep, spec field, prompt context
- src/server/services/interactiveActorHost/brainstormSourceMount.ts: `turnReadSources(spec)`; used in entrypoint.ts + interactiveSessionActor.ts
- src/client/hooks/useLinkedContext.ts + src/client/components/InterviewReferenceRepositories.tsx; rendered in InterviewChatView.tsx Linked Context dialog

## Done
- [x] Migration + schema + flag seed
- [x] Link service, routes, shared types
- [x] Turn spec field, validator, admission wiring, prompt instructions
- [x] Worker reuse (mount, reader, warm, agent-cache signature)
- [x] Client section in persisted Linked Context dialog
- [x] Tests: interviewLinkService, durableInteractiveTurnTypes, durableInteractiveTurnPrompt, interactiveActorHostEntrypoint (all pass); tsc server+client clean; eslint 0 errors

## Next
1. User is testing PR #290 in dev: run migrations, enable the flag for the project, add catalog repos on the Brainstorm card, link them to an interview, and walk a Technical turn end to end.
2. Decide on follow-ups: kickoff picker, handoff carry-over, legacy in-process path.

## Mistakes to avoid (learned in earlier chats)
- Linked Design Modules do NOT bring other repos; they only render globs into a context doc.
- Worker test fixtures often omit `workflowClass`; `turnReadSources` returns undefined (no throw) on unknown classes, so fixtures carrying sources must set `workflowClass`.
- Don't use `formatSourcesContext` from Brainstorm for interviews: it tells the agent to use `search_repo_code`, which interview Technical turns close.
- Plain `npx eslint` fails (flat config); use `npx cross-env ESLINT_USE_FLAT_CONFIG=false eslint <files>`.

## Verify with
- `npx jest src/server/__tests__/interviewLinkService.test.ts src/server/__tests__/durableInteractiveTurnTypes.test.ts src/server/__tests__/durableInteractiveTurnPrompt.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts --silent`
- `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`
- `npm run lint:check`

## Open questions for the user
- Should Technical turns allow `search_repo_code` inside reference repos (today interview policy closes search everywhere)?
- Should the interview record which reference repo commits were read?
