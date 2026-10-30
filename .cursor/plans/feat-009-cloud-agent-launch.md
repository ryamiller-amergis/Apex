# FEAT-009 — Cloud Agent Launch and Execution Snapshot

Branch: `feature/feat-009-cloud-agent-launch` (off `main` at 5bcb3b5e). Not committed.
Context pack: `.ai-pilot/local-dev/feat-009/`.

## Status
Implementation complete. Server + client `tsc` clean, 9 impacted Jest suites (255 tests) pass, ESLint clean.

## Decisions (operator-confirmed)
- Snapshot lives in new `agent_runs.build_launch_snapshot` JSONB (write-once trigger); `execution_snapshot` holds a stub.
- Prompt/context Blob pointers reuse `cursor-prompts` with a `builds/` key prefix (no infra change).
- Planner keeps the My Work input shape with `openPullRequest: false`; `planningDeps.ts` untouched.
- SDK has no branch-name option: client appends "Work on branch `<name>`" to build prompts.

## Files
- `src/server/services/cursorCloudAgentClient.ts` — union input, `CloudAgentLaunchRefusedError`, model required.
- `src/shared/types/buildLaunchSnapshot.ts` — snapshot + refusal types.
- `src/server/services/buildExecutionSnapshot.ts` — pure validator, `createSecretValueDetector`.
- `src/server/services/buildAgentLaunchService.ts` — `writeBuildLaunchSnapshot`, `launchBuildAgentRun`, `readBuildPromptBlob`.
- `migrations/20261029170000_c9a1_build-launch-snapshot.sql` + `src/server/db/schema.ts`.
- Tests: `cursorCloudAgentClient`, `buildExecutionSnapshot`, `buildLaunchSnapshotMigration`, `buildAgentLaunchService`, `cloudAgentBuildRowIsolation` under `src/server/__tests__/`.

## Open (not blocking this Feature)
- Assumption 3: shared user-level Cursor key vs per-requester credential — blocks Internal rollout.
- Assumption 7: My Work sweep can mark build rows terminal first — FEAT-010 completion handler must tolerate it.
- Manual launch against a throwaway repo (starting ref honoured, no PR, branch name followed) before rollout.
- Run the migration locally (`npm run migrate:local:up`) to exercise the trigger against real Postgres.
