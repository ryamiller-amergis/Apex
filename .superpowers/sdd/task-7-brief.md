### Task 7: Remove every enabled-path execution fallback

**Files:**

- Modify: `src/server/services/interactiveWorkflowRouter.ts`
- Modify: `src/server/services/interactiveActorAdmissionService.ts`
- Modify: `src/server/services/chatAgentService.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/client/hooks/useAgentChatSession.ts`
- Modify: `src/client/components/ChatAgentPanel.tsx`
- Modify: `src/client/components/InterviewChatView.tsx`
- Modify: `src/client/components/AdrChatView.tsx`
- Modify: `tests/e2e/specs/ai-runs-interactive-transport.spec.ts`
- Test: `src/server/__tests__/interactiveV2NoFallback.test.ts`
- Test: `src/server/__tests__/interactiveWorkflowRouter.test.ts`
- Test: `src/server/__tests__/chatAgentService.test.ts`
- Test: `src/server/__tests__/chatRoutes.test.ts`

**Interfaces:**

- Consumes: all completed Task 1–6 paths.
- Produces: a source/runtime guard proving canonical enabled traffic has no
  App Service Cursor/model fallback, while the canonical disabled/error branch
  still owns the current behavior.

- [ ] **Step 1: Write the enabled-path no-fallback guard**

The test must inspect imports and inject every failure point:

```typescript
it.each([
  'attachment-validation',
  'attachment-upload',
  'classification',
  'grounding',
  'database',
  'outbox',
] as const)('does not execute current path after %s failure', async (stage) => {
  canonicalFlag.mockResolvedValue(true);
  failStage(stage);
  await expect(router.route(input)).rejects.toBeDefined();
  expect(runLegacy).not.toHaveBeenCalled();
  expect(runInProcess).not.toHaveBeenCalled();
  expect(postLegacyActor).not.toHaveBeenCalled();
});
```

Scan `durableInteractiveTurnService.ts`,
`durableInteractiveTurnRepository.ts`, the route handler, and retry call graph;
fail if those import `@cursor/sdk`, `bedrockService`, `Agent`, or the in-process
execution function. `chatAgentService.ts` still contains the legacy
implementation for flag-off, so prove through injected callbacks that its
canonical enabled branch never calls it. Scan every server reference to
`sendMessageLegacy` and fail unless its containing file is
`chatAgentService.ts`.

- [ ] **Step 2: Run the guard and verify red**

Run:

```bash
npx jest src/server/__tests__/interactiveV2NoFallback.test.ts --runInBand
```

Expected: FAIL while old router/admission types still describe shed/race
fallback as the active contract.

- [ ] **Step 3: Isolate legacy admission instead of deleting it**

Keep `interactiveActorAdmissionService` and its `4 + 12` behavior callable only
from the canonical disabled/error branch. Rename comments/types that imply it
governs Task 7. Mark BR-014 and BR-017 as legacy-only and point to the approved
design.

Remove these outcomes from the canonical enabled branch:

- dispatch URL unset
- attachments bypass
- workspace-bound skill bypass
- custom MCP bypass
- ADO/tool-heavy bypass
- over-capacity shed
- actor post failure fallback

Each is now supported by Tasks 2–4 or returns the exact explicit validation
error. No canonical-enabled catch block calls current execution.

- [ ] **Step 4: Add user-visible queued/dispatched and cap copy**

After `InteractiveTurnAcceptedResponse`, show “Queued”. On durable dispatched
phase, show “Dispatched”. Do not show a numeric position or wait estimate.

Map:

- `USER_INTERACTIVE_LIMIT` → “You already have two active AI turns. Finish or
  stop one before starting another.”
- `USER_AGENTIC_LIMIT` → “You already have an agentic AI turn running. Finish
  or stop it before starting another.”

Keep the composer disabled for the active run in the current thread. Switching
to another thread permits a second turn.

- [ ] **Step 5: Update the transport E2E contract**

The E2E test must prove:

1. canonical flag false preserves the current response/path
2. canonical flag true returns `{turnId,runId,status,interactiveClass}`
3. queued then dispatched labels appear
4. WebSocket failure switches to SSE but does not send another message
5. failed-run retry keeps one user bubble
6. unsupported stdio MCP returns 422 and starts no App Service AI work
7. global saturation leaves the request queued
8. a third per-user turn returns 429

Use mocked actor/Redis boundaries; do not require or change Azure.

- [ ] **Step 6: Run Task 7 green checks**

Run:

```bash
npx jest src/server/__tests__/interactiveV2NoFallback.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/interactiveActorAdmissionService.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/chatRoutes.test.ts src/client/hooks/__tests__/useAgentChatSession.test.ts --runInBand
npx playwright test tests/e2e/specs/ai-runs-interactive-transport.spec.ts --project=chromium
npm run build
```

Expected: PASS. The legacy admission suite remains green, but every canonical
enabled case proves no fallback.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/server/services/interactiveWorkflowRouter.ts src/server/services/interactiveActorAdmissionService.ts src/server/services/chatAgentService.ts src/server/routes/chat.ts src/client/hooks/useAgentChatSession.ts src/client/components/ChatAgentPanel.tsx src/client/components/InterviewChatView.tsx src/client/components/AdrChatView.tsx tests/e2e/specs/ai-runs-interactive-transport.spec.ts src/server/__tests__/interactiveV2NoFallback.test.ts src/server/__tests__/interactiveWorkflowRouter.test.ts src/server/__tests__/chatAgentService.test.ts src/server/__tests__/chatRoutes.test.ts
git commit -m "fix: remove enabled interactive execution fallback"
```
