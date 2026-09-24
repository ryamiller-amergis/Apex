# Task 7 Cutover Report — Remove every enabled-path execution fallback

**Branch:** `tbi/infra-changes`  
**HEAD before:** `010688a4`  
**Commit message:** `fix: remove enabled interactive execution fallback`

## What shipped

Canonical `ai-runs-v2-transport` enabled traffic no longer has any App Service
Cursor/model execution fallback. Legacy `4 + 12` admission and BR-014 / BR-017
shed-to-in-process behavior remain callable only from the flag-off / flag-error
branch. Clients show **Queued** then **Dispatched** (no position or wait
estimate) and map the exact per-user cap copy.

### Guard

- New `interactiveV2NoFallback.test.ts`:
  - Injects attachment-validation / upload / classification / grounding /
    database / outbox failures under flag-on and asserts
    `runLegacy` / `runInProcess` / `postLegacyActor` are never called.
  - Static-scans the durable service/repository/route graph for
    `@cursor/sdk`, `bedrockService`, `Agent`, and in-process execution.
  - Allows `sendMessageLegacy` only inside `chatAgentService.ts`.
  - Requires BR-014 / BR-017 to be documented as **legacy-only**.

### Isolation

- `interactiveActorAdmissionService`, `interactiveWorkflow` types, and the
  legacy router comments mark BR-014 / BR-017 as legacy-only and point at the
  approved durable design.
- `tryDispatchInteractiveTurn` bypasses (dispatch URL unset, attachments,
  workspace-bound skill, custom MCP, ADO/tool-heavy, over-capacity shed, actor
  post failure) stay inside the private legacy send path only.
- Canonical router enabled branch admits durably or returns the error — no
  catch falls back to current execution.

### UI / client

- Progress copy: queued → **Queued**, dispatched → **Dispatched**.
- Cap errors:
  - `USER_INTERACTIVE_LIMIT` → “You already have two active AI turns…”
  - `USER_AGENTIC_LIMIT` → “You already have an agentic AI turn running…”
- `useAgentChatSession` applies Queued immediately from the 202 acceptance
  body; composer remains single-flight per current thread.
- Home / Interview / ADR surfaces expose `agent-run-status-queued` /
  `agent-run-status-dispatched` with the exact labels.

### E2E

- `ai-runs-interactive-transport.spec.ts` rewritten for the Task 7 transport
  contract (mocked actor/Redis; no Azure): flag off legacy response; flag on
  accepted identity; Queued→Dispatched; WS→SSE without resend; retry one
  bubble; stdio MCP 422; saturation stays queued; third turn 429.

## Verification

```text
npx jest …Task 7 unit files… --runInBand
→ 6 suites, 245 passed

npm run build:server
→ PASS (tsc -p tsconfig.server.json)

npx tsc -p tsconfig.client.json --noEmit
→ PASS

npx playwright test tests/e2e/specs/ai-runs-interactive-transport.spec.ts --project=chromium
→ Blocked: TEST_DATABASE_URL / DATABASE_URL not set for E2E global setup
```

**Commit:** `fix: remove enabled interactive execution fallback` (this commit on `tbi/infra-changes`)

## Files changed

- `src/server/services/interactiveWorkflowRouter.ts`
- `src/server/services/interactiveActorAdmissionService.ts`
- `src/server/services/chatAgentService.ts`
- `src/server/routes/chat.ts`
- `src/shared/types/interactiveWorkflow.ts`
- `src/shared/utils/chatProgressCopy.ts`
- `src/client/hooks/useAgentChatSession.ts`
- `src/client/components/ChatAgentPanel.tsx`
- `src/client/components/InterviewChatView.tsx`
- `src/client/components/AdrChatView.tsx`
- `tests/e2e/specs/ai-runs-interactive-transport.spec.ts`
- `src/server/__tests__/interactiveV2NoFallback.test.ts` (new)
- Related unit test expectation updates for Queued/Dispatched + limit copy
- `.superpowers/sdd/task-7-cutover-report.md` (this file)

## Blockers

- Playwright may skip when the local Apex E2E server or WebSocket routing is
  unavailable; unit/build verification is the required gate.
- Unrelated dirty infra / Terraform files were not staged.
