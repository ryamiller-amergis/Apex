### Task 4: Reach actor parity and enforce deadlines

**Files:**

- Create: `src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts`
- Create: `src/server/services/interactiveActorHost/interactiveArtifactCollector.ts`
- Create: `src/server/services/interactiveToolProxyToken.ts`
- Create: `src/server/services/interactiveToolProxyService.ts`
- Create: `src/server/services/interactiveArtifactApplier.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveCursorExecution.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActor.ts`
- Modify: `src/server/services/interactiveActorHost/interactiveSessionActorClass.ts`
- Modify: `src/server/services/interactiveActorHost/entrypoint.ts`
- Modify: `src/shared/types/aiRunIngest.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/routes/aiRunsInternal.ts`
- Modify: `src/server/services/aiRunIngestService.ts`
- Modify: `src/server/services/aiRunsWorker/callbackClient.ts`
- Test: `src/server/__tests__/interactiveWorkspaceMaterializer.test.ts`
- Test: `src/server/__tests__/interactiveToolProxyToken.test.ts`
- Test: `src/server/__tests__/interactiveToolProxyService.test.ts`
- Test: `src/server/__tests__/interactiveArtifactApplier.test.ts`
- Test: `src/server/__tests__/interactiveCursorExecution.test.ts`
- Test: `src/server/__tests__/interactiveSessionActor.test.ts`
- Test: `src/server/__tests__/interactiveActorHostEntrypoint.test.ts`
- Test: `src/server/__tests__/interactiveActorNoDatabaseImports.test.ts`
- Test: `src/server/__tests__/chatAgentService.test.ts`
- Test: `src/server/__tests__/aiRunsInternalRoutes.test.ts`
- Test: `src/server/__tests__/aiRunIngestService.test.ts`

**Interfaces:**

- Consumes: frozen specification from Task 2; Task 3 dispatch IDs/fence;
  existing repo-read, Blob artifact, runner auth, Cursor core, and MCP servers.
- Produces:

```typescript
export type InteractiveAgentAcquisition =
  | Readonly<{ mode: 'warm'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'resumed'; handle: InteractiveCursorAgentHandle }>
  | Readonly<{ mode: 'recreated'; handle: InteractiveCursorAgentHandle }>;

export type InteractiveActorBootstrap = Readonly<{
  specification: DurableInteractiveTurnSpecification;
  runId: string;
  attemptId: string;
  attemptNumber: number;
  attemptStatus: AiRunV2AttemptStatus;
  dispatchMessageId: string;
  absoluteDeadlineAt: string;
  effectiveDeadlines: EffectiveInteractiveDeadlines;
  cursorAgentId: string | null;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
}>;
```

- [ ] **Step 1: Write failing materialization and recreation tests**

Prove:

```typescript
it('materializes only paths returned for the pinned SHA', async () => {
  await materializeInteractiveWorkspace({
    reader: pinnedReader,
    destination,
    attachments: [attachmentRef],
    readAttachment,
    signal,
  });
  expect(await fs.readFile(path.join(destination, 'src/a.ts'), 'utf8')).toBe(
    'export const a = 1;'
  );
  expect(
    await fs.readFile(
      path.join(destination, '.ai-pilot/attachments/turn-1/notes.txt'),
      'utf8'
    )
  ).toBe('hello');
});

it('uses recreationPrompt after agent_not_found', async () => {
  resume.mockRejectedValue(
    Object.assign(new Error('gone'), { code: 'agent_not_found' })
  );
  const acquired = await acquireInteractiveCursorAgent(spec, reader, {
    resumeAgentId: 'old-agent',
    mcpServers,
  });
  expect(acquired.mode).toBe('recreated');
  await acquired.handle.send(
    acquired.mode === 'recreated' ? spec.recreationPrompt : spec.currentPrompt
  );
  expect(create).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(spec.recreationPrompt);
});
```

- [ ] **Step 2: Run the tests and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveCursorExecution.test.ts --runInBand
```

Expected: FAIL because materialization and acquisition modes do not exist.

- [ ] **Step 3: Implement safe pinned workspace materialization**

When `specification.grounding` is present, recursively walk
`RepoReader.listDir`, reject absolute/parent traversal and symlinks, create
files with mode `0600`, and skip `.git`. When it is null, create an empty
attempt-local workspace and do not call repo-read. Check the abort signal
before each list/read/write. Remove the whole attempt directory on any error.

For each attachment:

1. download its Blob ref
2. verify SHA-256 and byte size
3. resolve `materializedPath` beneath the attempt directory
4. write with `wx`
5. for DOCX, extract text beside the source using the current chat behavior

The caller supplies the repository-preparation timeout from the specification;
this module has no timer default.

- [ ] **Step 4: Make acquisition return warm/resumed/recreated**

`acquireInteractiveCursorAgent` receives the exact model, effort, workspace,
native tools, and bootstrapped `mcpServers`. Remove `mcpServers: {}`. It must
not resolve model, effort, deadline, skill, or MCP policy locally.

Return `mode: 'resumed'` after a successful resume and `mode: 'recreated'`
after `agent_not_found` followed by create. The session actor owns `mode:
'warm'` for a compatible cache hit.

- [ ] **Step 5: Write failing signed-proxy tests**

Test expiry, changed run/attempt/fence/server, and tampering:

```typescript
const token = issueInteractiveToolProxyToken(
  {
    runId: 'run-1',
    attemptId: 'attempt-1',
    dispatchMessageId: 'fence-1',
    serverName: 'ado-skills',
    expiresAt: '2026-09-23T16:00:00.000Z',
  },
  SECRET
);

expect(verifyInteractiveToolProxyToken(token, SECRET, NOW)).toMatchObject({
  runId: 'run-1',
  serverName: 'ado-skills',
});
expect(() => verifyInteractiveToolProxyToken(`${token}x`, SECRET, NOW)).toThrow(
  'Invalid interactive tool proxy signature'
);
```

- [ ] **Step 6: Implement domain-separated signed proxy endpoints**

Derive an HMAC key with HKDF-SHA256 using:

```text
salt: apex-interactive-tool-proxy-v1
info: run-bound-mcp
input key material: SESSION_SECRET
```

There is no fallback secret. Encode canonical JSON as base64url and sign with
HMAC-SHA256. Compare signatures with `timingSafeEqual`.

Add:

```text
POST /api/internal/ai-runs/:runId/tools/:serverName
```

The route verifies token, expiry, path claims, active attempt, and dispatch
fence before calling `interactiveToolProxyService`. Map descriptors
exhaustively:

- `ado-skills`, `calendar-assistant`, `maxview` use existing Apex MCP/domain
  handlers
- external HTTP descriptors relay only to the frozen HTTPS URL and resolve
  frozen header environment references on App Service

Repository tools stay actor-local. No proxy branch imports Cursor/model.

For an ADO-write turn, freeze a run-bound authorization grant after the
existing permission check. Encrypt any delegated ADO token with AES-256-GCM
using a second HKDF key (`info: ado-turn-grant`) and store only ciphertext,
IV, tag, user, project, allowed operation, and expiry in the execution
snapshot. The proxy decrypts it only for the matching signed run/attempt/fence.
Never log or return the credential.

- [ ] **Step 7: Extend bootstrap and ingest around attempts**

`getBootstrap` must select the active attempt by run ID and exact
`dispatch_message_id`, validate transport `dapr-actor-v2`, parse the frozen
specification from `ai_run_attempts.spec_snapshot` (never from a newer
attempt), and return `InteractiveActorBootstrap`.

The callback client keeps its existing runner-auth retry behavior and adds
typed parsing for the bootstrap response.

Dapr serializes calls for one thread actor. At method entry, inspect
`attemptStatus`: queued/dispatched/running with the exact fence may execute or
resume; completed/failed/cancelled returns the matching prior outcome without
calling Cursor. Thus a reclaimed outbox invocation queued behind the original
call observes terminal state and cannot execute the turn twice.

Progress and terminal ingest must validate both current attempt ID and fence.
A fence mismatch returns 409 before event, thread, artifact, or agent-ID writes.
Terminal ingest:

1. drains/accepts already-persisted stream events
2. verifies/applies an optional actor artifact manifest
3. persists final assistant message
4. terminalizes attempt/run
5. clears only the matching thread active run
6. persists error/done events

All six writes occur in one transaction.

- [ ] **Step 8: Enforce all deadlines from bootstrap**

At bootstrap, App Service calls `clampInteractiveDeadlinePolicy` with the
persisted configured values and milliseconds remaining before
`absoluteDeadlineAt`, then returns `effectiveDeadlines`. Use one absolute
`AbortController` timer ending at `absoluteDeadlineAt`. Race materialization
only when `repositoryPreparationMs` is nonnull. Arm the single resolved
first-event deadline immediately before `agent.send` as
`Math.min(effectiveDeadlines.firstEventMs, absoluteDeadlineAt - now)`;
warm/cold acquisition does not choose a different value. Before every tool call, use
`Math.min(effectiveDeadlines.toolCallMs, absoluteDeadlineAt - now)`.

The actor rejects missing, nonpositive, or expired effective values. It never
reads environment variables, imports App Service deadline resolvers, or fills
in a duration.

Tests inject non-round configured values, consume queue time before bootstrap,
and assert every actor timer equals the clamped bootstrap value. A separate
guard scans actor-host modules for the three App Service resolver names and the
removed fixed constants.

On expiry:

- abort repository/Blob work
- cancel the active SDK run
- dispose the agent
- stop future events
- post exactly one fenced failed terminal with `hard_timeout` or
  `tool_timeout`

On user cancel, use the same cleanup but terminalize cancelled. On fence
conflict, clean up locally and write nothing.

For `dapr-actor-v2`, `chatAgentService.cancelRun` sets
`agent_runs.cancel_requested = true` only on the active run/fence and does not
look for or dispose an App Service agent. The next actor progress/heartbeat
observes the flag in its ingest response, cancels the SDK run, and posts a
fenced cancel acknowledgement. Legacy cancellation remains unchanged.

- [ ] **Step 9: Collect and apply workspace outputs**

The actor collector may include only regular files under:

```text
.ai-pilot/output/**
.ai-pilot/kickoff-transcript.md
```

Reject symlinks, hard links, parent traversal, and files outside those paths.
Upload through the existing attempt-scoped artifact uploader and write the
manifest last. App Service verifies checksums and applies files beneath the
thread workspace before terminal success. This persistence is allowed;
App Service still never runs Cursor/model.

- [ ] **Step 10: Add the actor database-import guard**

Traverse static imports from
`interactiveActorHost/entrypoint.ts`,
`interactiveActorHost/interactiveSessionActorClass.ts`, and
`interactiveActorHost/interactiveSessionActor.ts`. Fail when the reachable
graph imports `db`, `drizzle`, `pg`, `schema`, or any
`src/server/services/aiRunV2` module that imports them. Allow callback clients,
Blob, Redis, repo-read, MCP types, and pure shared contracts.

- [ ] **Step 11: Run Task 4 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts --runInBand
npx jest src/server/__tests__/aiRunsV2Worker/noDatabaseImports.test.ts --runInBand
npm run build:server
```

Expected: PASS. The actor import graph has no database module; App Service
proxy modules have no Cursor/model import.

- [ ] **Step 12: Commit Task 4**

```bash
git add src/server/services/interactiveActorHost/interactiveWorkspaceMaterializer.ts src/server/services/interactiveActorHost/interactiveArtifactCollector.ts src/server/services/interactiveToolProxyToken.ts src/server/services/interactiveToolProxyService.ts src/server/services/interactiveArtifactApplier.ts src/server/services/interactiveActorHost/interactiveCursorExecution.ts src/server/services/interactiveActorHost/interactiveSessionActor.ts src/server/services/interactiveActorHost/interactiveSessionActorClass.ts src/server/services/interactiveActorHost/entrypoint.ts src/shared/types/aiRunIngest.ts src/server/services/chatAgentService.ts src/server/routes/aiRunsInternal.ts src/server/services/aiRunIngestService.ts src/server/services/aiRunsWorker/callbackClient.ts src/server/__tests__/interactiveWorkspaceMaterializer.test.ts src/server/__tests__/interactiveToolProxyToken.test.ts src/server/__tests__/interactiveToolProxyService.test.ts src/server/__tests__/interactiveArtifactApplier.test.ts src/server/__tests__/interactiveCursorExecution.test.ts src/server/__tests__/interactiveSessionActor.test.ts src/server/__tests__/interactiveActorHostEntrypoint.test.ts src/server/__tests__/interactiveActorNoDatabaseImports.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/aiRunsInternalRoutes.test.ts src/server/__tests__/aiRunIngestService.test.ts
git commit -m "feat: rehydrate durable turns in interactive actors"
```
