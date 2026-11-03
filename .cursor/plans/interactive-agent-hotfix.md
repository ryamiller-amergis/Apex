# Interactive agent hotfix

Branch: `hotfix/interactive-agent-start-timeouts` (off `main` at b731f5fb, upstream unset; push with `git push -u origin hotfix/interactive-agent-start-timeouts`).

## Incident (prod, 2026-10-14, interview 07d4a474, thread 2bae1244)
- 9:59 ET run 2e63d361: actor stuck in the App Service bootstrap fetch for 240s (run stayed `dispatched`; Dapr actor invocation 240,030 ms, ended 499). Reaper killed it at 60s; next dispatch queued behind the actor lock.
- 10:03 ET run 4fac6170: agent acquired, Cursor stream (`rpc.run`) opened 10:03:35, closed early ("Premature close") 10:05:42 without `turn-ended`; worker waited on `run.wait()` until user Stop at 10:09:41. Durable running turns are reaped only on heartbeat, which kept ticking.
- Recovered by restarting `ca-apex-ai-agentic-prd--0000005` (rg-apex-prd-app).

## Changes
1. `cursorExecutionCore.ts`: opt-in `failIfStreamEndsBeforeTurnEnd` — stream ends without turn end and `wait()` doesn't settle within the turn-end settle window: cancel and throw.
2. `interactiveSessionActor.ts` durable turn: event-gap timer — after the first event, no Cursor event for `firstEventMs` (tool timer governs while a tool runs) fails the turn.
3. `callbackClient.ts`: opt-in `requestTimeoutMs`; interactive host sets it so bootstrap/ingest can't hang (timeouts retry like other transport failures).
4. Agent lifecycle: first-event timer covers acquisition (start/resume); dispose waits are bounded; an agent id whose resume timed out is not resumed again.
5. JSON log events for acquire/dispose/stream-close/silence.

## Status
- [x] 1 [x] 2 [x] 3 [x] 4 [x] 5 [x] tests [x] typecheck/lint [x] commit [x] PR [ ] dev test [ ] prod
- Commit `179acf52`, pushed; PR https://github.com/ryamiller-amergis/Apex/pull/214.
- Security review follow-up `927c49bf`: hard timeout or early stream close marks the Agent id unresumable (next turn recreates); early stream close waits up to 5s for cancel(). Declined: blocking the thread queue / quarantining the workspace until cancel+dispose settle — that reintroduces the "Dispatched" hang, and abandoned runs on timeout predate this PR.
- Known UI/server mismatch (deferred by user): `InterviewChatView.tsx` lets admins type in another user's interview, but `canWriteThread` is owner-only, so they get 404 "Thread not found". Fold into the non-owner message follow-up when picked up.
- Change 1 detail: after the stream ends, the core waits up to `turnEndSettleMs` (5s) for either a late turn end or `wait()` to settle; only if neither happens does it fail (`CursorStreamClosedBeforeTurnEndError` inside `CursorExecutionWaitError`). Cancel is fire-and-forget.
- Change 2 detail: silence timer only arms when `firstEventMs` < time left on the absolute deadline, so near the end the absolute timer gives the right label.
- Callback timeout: 12s per request in `entrypoint.ts` (4 attempts + 3.5s backoff ≈ 52s < 60s reaper start timeout).
- Dispose cap: `INTERACTIVE_AGENT_DISPOSE_WAIT_MS` = 5s.
- New log events: `InteractiveAgentAcquired`, `InteractiveAgentAcquireTimedOut`, `InteractiveAgentDisposeTimedOut`, `InteractiveStreamClosedBeforeTurnEnd`, `InteractiveTurnWentSilent`.
- New terminal details: "Interactive turn went silent", "Interactive turn failed: Cursor stream closed before the turn finished".
- Tests: 32 related suites (360 tests) pass. Full suite: 2 git-heavy suites (`groundingBundleStoreService`, `repoReader`) hit Jest's 5s limit even when run alone; they don't import changed files.

## Dev test plan
- Long guided interview (15+ questions) including the product→technical phase change; confirm no "Dispatched" hangs and that App Insights shows `InteractiveAgentAcquired` with mode warm/resumed/recreated.

## Follow-ups (separate PRs, approved)
- Pin grounding commit per interview (no per-question fetch; agent stays warm).
- Non-owner send: "Only the interview owner can reply" instead of 404 "Thread not found".
- Not approved yet: standup scheduler PG 54023 every 5 min since 9:28 ET; why the bootstrap request stalled.
