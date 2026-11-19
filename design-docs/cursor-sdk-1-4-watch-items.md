# Cursor SDK 1.4.0 watch items

Recorded during the FEAT-001 upgrade from `@cursor/sdk` `1.0.37` to `1.4.0`. Names below were read from the installed package and from `scripts/cursor-sdk-contract/cursor-sdk-1.4.0.contract.json`.

## Confirmed API

| Item | Result |
|------|--------|
| Package pin | `package.json`, the lockfile root, and `node_modules/@cursor/sdk` resolve to `1.4.0`. |
| `CursorSDK` class | Not exported. `Agent` and `Cursor` are functions. `apexWorkItemService.generateDraftsFromFeatureRequest` now calls `Agent.create` and `send`. A missing key or a failed turn still returns the local fallback draft. |
| Deep type paths | `dist/cjs/agent.d.ts` and `dist/cjs/options.d.ts` still exist, so the current `import type` lines type-check. The matching `.js` files are gone. Server `tsc` is clean after the bump. |
| Summary events | Present. Runtime exports include `SummaryStartedUpdateSchema`, `SummaryUpdateSchema`, and `SummaryCompletedUpdateSchema`. `SDKMessage` includes `SDKSummaryMessage`. |
| Steer | `Run.steer?(text: string): Promise<SteerAckOutcome>`. Outcomes are `"complete_delivered"`, `"revert_to_followup"`, and `{ outcome: "queued"; run?: Run }`. |
| Summarize | `SDKAgent.summarize(): Promise<Run>`. |
| Usage and cost | `TokenUsage` is token counts. `AgentUsage.cost` and turn `usage.cost` are optional `UsageCost` (float cents). Cost can be absent. Ingest keeps computing cost from tokens. |
| Per-send id | `SendOptions` and `LocalSendOptions` have no `requestId`. The caller-supplied per-send field is `idempotencyKey`. `Run.requestId` and `RunResult.requestId` are optional values the SDK returns. The adapter forwards the specification `requestId` as `idempotencyKey` and keeps any SDK-returned `requestId` on the run. |
| Server type-check | `npx tsc -p tsconfig.server.json --noEmit` exited 0 after the bump and the `Agent.create` migration. |

## Impact-area consumer test pass (TBI-001 DoD-2 / DoD-3)

| Consumer / impact area | Verification suite(s) | Result on 1.4.0 |
|------------------------|-----------------------|-----------------|
| SDK contract pin & exports | `cursorSdkContract.test.ts` | PASS |
| Agent Home / chat services | `chatAgentService.test.ts`, `chatRunEvents.test.ts` | PASS |
| Ask Apex & grounding | `askApexService.test.ts`, `askApexGrounding.test.ts` | PASS |
| Interactive actor host | `interactiveCursorExecution.test.ts` | PASS |
| Execution core & `wait()` workarounds | `cursorExecutionCore.test.ts` | PASS |
| Native read tools & interview grounding | `nativeReadReadPath.test.ts`, `nativeReadToolAdapter.test.ts`, `interviewGroundingPolicy.test.ts` | PASS |
| Models catalog & probe | `modelsService.test.ts` | PASS |
| Grounding impact evaluator | `groundingImpactEvaluatorService.test.ts` | PASS |
| Playbooks Cursor execution policy | `playbookCursorExecutionPolicy.test.ts` | PASS |
| Walkthrough AI draft provider | `walkthroughAiDraftCursorProvider.test.ts` | PASS |
| Observability PO digest | `observabilityPoDigestService.test.ts` | PASS |
| Release changelog sidecar | `releaseChangelogService.test.ts` | PASS |
| Apex work item draft generation | `apexWorkItemsRoutes.test.ts` (`Agent.create` replacement for removed `CursorSDK`) | PASS |
| My Work — Start Local Development & Cloud Agent runs | `cursorCloudAgentClient.test.ts`, `cloudAgentService.test.ts`, `buildAgentLaunchService.test.ts`, `devWorkbenchRoutes.test.ts`, `myWorkSdkUpgrade.test.ts`, `DevWorkbenchView.test.tsx`, `canAccessMyWork.test.ts` (`tests/e2e/specs/my-work-sdk-upgrade.spec.ts` authored; live browser run deferred because the developer's active Vite process listens on `::1:3000` rather than `127.0.0.1:3000`) | PASS (unit/integration); E2E authored & deferred |

## Watch-item outcomes (TBI-001 DoD-4)

| Watch item | Result / follow-up note |
|------------|-------------------------|
| 1. Reliable `wait()` | `cursorExecutionCore.test.ts` passes all closed-stream and unsettled-`wait()` cases (`failIfStreamEndsBeforeTurnEnd`, `turnEndSettleMs`, cancel-then-wait, `CursorExecutionWaitError` wrapping `CursorStreamClosedBeforeTurnEndError`). Workarounds stay in place as planned; live removal remains a follow-up once deployed 1.4.0 telemetry shows zero unsettled closes. |
| 2. Recreated turns from `1.0.37` agents | `1.4.0` preserves `Agent.resume(agentId, options)` and `AgentNotFoundError` (`code: 'agent_not_found'`). Live resume ratio from pre-existing `1.0.37` store entries cannot be measured offline without a deployed `1.0.37` store; the adapter keeps structural `agent_not_found` recreation, and a release-day burst of recreated turns remains expected per PRD assumption. |
| 3. Automatic `summary` events | Confirmed present in `1.4.0`: `SDKSummaryMessage` in `messages.d.ts` and runtime Zod schemas `SummaryStartedUpdateSchema`, `SummaryUpdateSchema`, and `SummaryCompletedUpdateSchema`. Normalized in TBI-003. |
| 4. Large-context (max-mode) model turn | `modelsService.ts` probe path (`Agent.create` with `local.cwd` + `send(PROBE_PROMPT)` + `wait()`) compiles and passes `modelsService.test.ts` on `1.4.0`. Live credentialed probe against a max-mode model ID requires `CURSOR_API_KEY` in the target environment and is recorded as a post-deploy check; unit/adapter coverage exercises max-mode model selection in Wave 3 (`VT-06`). |
| 5. Deploy window | No deploy fell in this local session window; noted for TBI-004 baseline recording. |
