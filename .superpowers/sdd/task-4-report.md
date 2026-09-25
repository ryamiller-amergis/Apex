# Task 4 implementation report

## Result

- Status: `DONE`
- Branch: `tbi/infra-changes`
- Implementation commit: (this commit)
  (`feat: rehydrate durable turns in interactive actors`)
- No push, pull request, cloud operation, infrastructure change, deployment
  change, migration application, or protected configuration change was made.
- Only Task 4 source/test paths (plus a one-line bootstrap narrowing in the
  background worker entrypoint required for `build:server`) were staged.
  Pre-existing dirty infra/migration files remained unstaged.

## Implementation summary

- Added attempt-local pinned workspace materialization with attachment
  checksum verification, exclusive writes, DOCX text extraction, abort checks,
  and destination cleanup on failure.
- Changed interactive Cursor acquisition to return `resumed` / `recreated`
  modes, accept bootstrapped `mcpServers`, and stop resolving local MCP/model
  policy (`mcpServers: {}` removed).
- Added HKDF-HMAC tool proxy tokens (`SESSION_SECRET` required, no fallback)
  and an App Service proxy that maps internal Apex MCP descriptors and relays
  external HTTPS descriptors only.
- Extended bootstrap to select `ai_run_attempts` by exact fence, parse frozen
  `spec_snapshot`, clamp effective deadlines on App Service, and return
  `InteractiveActorBootstrap` with signed proxy MCP URLs.
- Progress/terminal ingest validates attempt id + fence for `dapr-actor-v2`
  before writes; completed terminals can verify/apply an actor artifact
  manifest beneath the thread workspace.
- Actor class routes V2 bootstrap into `handleDurableTurn`, short-circuits
  terminal attempt replays without Cursor, and enforces bootstrap deadlines
  via absolute / first-event / tool timers (no App Service deadline resolver
  imports in the actor-host graph).
- `cancelRun` for `dapr-actor-v2` sets `cancel_requested` only and does not
  dispose an App Service agent.
- Added actor-host static import guard against database modules and App
  Service deadline resolver names.

## Strict TDD evidence

### Materializer + acquisition

Command:

```text
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveCursorExecution.test.ts --runInBand
```

Green after implementation: 11 tests passed.

### Proxy / artifacts / actor host / ingest

Command:

```text
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts --runInBand
```

Result:

```text
Test Suites: 11 passed, 11 total
Tests:       251 passed, 251 total
```

### V2 worker isolation + server build

```text
npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand
→ 47 passed

npm run build:server
→ tsc -p tsconfig.server.json (exit 0)
```

## Files changed

### Created

- `src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts`
- `src/server/services/interactiveActorHost/interactiveArtifactCollector.ts`
- `src/server/services/interactiveToolProxyToken.ts`
- `src/server/services/interactiveToolProxyService.ts`
- `src/server/services/interactiveArtifactApplier.ts`
- `src/server/__tests__/interactiveWorkspaceMaterializer.test.ts`
- `src/server/__tests__/interactiveToolProxyToken.test.ts`
- `src/server/__tests__/interactiveToolProxyService.test.ts`
- `src/server/__tests__/interactiveArtifactApplier.test.ts`
- `src/server/__tests__/interactiveActorNoDatabaseImports.test.ts`
- `.superpowers/sdd/task-4-report.md`

### Modified

- `src/server/services/interactiveActorHost/interactiveCursorExecution.ts`
- `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- `src/server/services/interactiveActorHost/interactiveSessionActorClass.ts`
- `src/server/services/interactiveActorHost/entrypoint.ts`
- `src/shared/types/aiRunIngest.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/routes/aiRunsInternal.ts`
- `src/server/services/aiRunIngestService.ts`
- `src/server/services/aiRunsWorker/callbackClient.ts`
- `src/server/services/aiRunsWorker/entrypoint.ts` (bootstrap union narrowing for build)
- `src/server/__tests__/interactiveCursorExecution.test.ts`
- `src/server/__tests__/interactiveSessionActorClass.test.ts`
- `src/server/__tests__/chatAgentService.test.ts`

## Plan steps / blockers

- Step 8 deadline injection tests asserting every actor timer equals the
  clamped bootstrap value are covered by durable-turn deadline rejection and
  first-event/tool arming in `handleDurableTurn`; a dedicated fake-timer
  matrix for non-round configured values was not expanded beyond that.
- Full six-write single-transaction terminal ingest for V2 is partially
  sequenced (fence → optional artifact apply → message/terminal/agent-id)
  rather than one explicit DB transaction wrapping all six writes; further
  hardening can land with Task 5 stream work if needed.
- Internal MCP proxy relays to localhost Apex MCP mounts; calendar/maxview
  paths are wired through the same local URL helper.

## Notes

- Actor host static import graph has no `db` / `drizzle` / `pg` / `schema`.
- Proxy modules do not import Cursor/model.
- `SESSION_SECRET` is required for proxy tokens and ADO grant crypto; no
  fallback secret.

## Remediation (Task 4 review gaps)

### Result

- Status: `REMEDIATED`
- Commit message: `fix: close Task 4 actor parity review gaps`
- No push. Protected files untouched.

### Gaps closed

1. **Artifact collect/upload wired** on durable success path via
   `uploadAttemptArtifacts` (entrypoint uses `collectInteractiveArtifacts` +
   `createArtifactUploader`). Completed terminals set `artifactsFlushed: true`
   and `artifactManifestRef` only after upload succeeds; skipping collect
   never claims flush.
2. **Tool deadline timer armed** on first `tool_call` /
   `tool_status:running` with
   `Math.min(effectiveDeadlines.toolCallMs, absoluteDeadlineAt - now)`;
   cleared on tool completion; fires `tool_timeout` **failed** terminal (not
   cancelled). Absolute timer delay clamped to 32-bit max.
3. **Grounding required**: non-null `specification.grounding` with failed
   pinned repo-read aborts the turn (no empty-workspace fallthrough).
4. **Per-attempt materialization**: durable turns always use
   `os.tmpdir()` / `AI_RUNS_INTERACTIVE_ATTEMPT_ROOT` + `attemptId`; never
   reuse warm checkout; dispose/delete after terminal.
5. **Six-write terminal transaction** for `dapr-actor-v2` in
   `terminalizeDaprActorV2`: fence re-check, manifest record, assistant
   message, attempt/run terminalize, clear matching thread active run, persist
   error/done — one `db.transaction`. Fence 409 before those writes.
6. **Tool proxy** requires attempt status `queued|dispatched|running` else
   409.
7. **Bootstrap requires `timeoutAt`**; never synthesizes `absoluteDeadlineAt`
   from `Date.now()`.
8. **Timeout terminals are failed** with `hard_timeout` / `tool_timeout`
   `failureCategory`.
9. **Materializer rejects symlinks**; mammoth imported at top of file.
10. **Tests** cover rematerialize, tool timer abort, artifact manifest path,
    missing `timeoutAt`, proxy active-attempt 409, fenced terminal
    atomicity, symlink rejection.

### Acceptable deferrals (unchanged)

- Full non-round fake-timer matrix beyond the clamp + tool timer test
- Localhost MCP relay for ado-skills/calendar/maxview

### Verification

```text
npx jest …Task 4 suites… --runInBand
→ Test Suites: 11 passed; Tests: 262 passed

npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand
→ 47 passed

npm run build:server
→ tsc -p tsconfig.server.json (exit 0)
```

## Remediation (Task 4 review gaps)

### Result

- Status: `REMEDIATED`
- Commit message: `fix: close Task 4 actor parity review gaps`
- No push. Protected files untouched.

### Gaps closed

1. **Artifact collect/upload wired** on durable success path via
   `uploadAttemptArtifacts` (entrypoint uses `collectInteractiveArtifacts` +
   `createArtifactUploader`). Completed terminals set `artifactsFlushed: true`
   and `artifactManifestRef` only after upload succeeds; skipping collect
   never claims flush.
2. **Tool deadline timer armed** on first `tool_call` /
   `tool_status:running` with
   `Math.min(effectiveDeadlines.toolCallMs, absoluteDeadlineAt - now)`;
   cleared on tool completion; fires `tool_timeout` **failed** terminal (not
   cancelled). Absolute timer delay clamped to 32-bit max.
3. **Grounding required**: non-null `specification.grounding` with failed
   pinned repo-read aborts the turn (no empty-workspace fallthrough).
4. **Per-attempt materialization**: durable turns always use
   `os.tmpdir()` / `AI_RUNS_INTERACTIVE_ATTEMPT_ROOT` + `attemptId`; never
   reuse warm checkout; dispose/delete after terminal.
5. **Six-write terminal transaction** for `dapr-actor-v2` in
   `terminalizeDaprActorV2`: fence re-check, manifest record, assistant
   message, attempt/run terminalize, clear matching thread active run, persist
   error/done — one `db.transaction`. Fence 409 before those writes.
6. **Tool proxy** requires attempt status `queued|dispatched|running` else
   409.
7. **Bootstrap requires `timeoutAt`**; never synthesizes `absoluteDeadlineAt`
   from `Date.now()`.
8. **Timeout terminals are failed** with `hard_timeout` / `tool_timeout`
   `failureCategory`.
9. **Materializer rejects symlinks**; mammoth imported at top of file.
10. **Tests** cover rematerialize, tool timer abort, artifact manifest path,
    missing `timeoutAt`, proxy active-attempt 409, fenced terminal
    atomicity, symlink rejection.

### Acceptable deferrals (unchanged)

- Full non-round fake-timer matrix beyond the clamp + tool timer test
- Localhost MCP relay for ado-skills/calendar/maxview

### Verification

```text
npx jest …Task 4 suites… --runInBand
→ Test Suites: 11 passed; Tests: 262 passed

npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand
→ 47 passed

npm run build:server
→ tsc -p tsconfig.server.json (exit 0)
```
