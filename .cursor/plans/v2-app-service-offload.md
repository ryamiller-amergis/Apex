# V2 App Service offload
Updated: 2026-11-02. Repo: Apex. Branch: feat/v2-app-service-offload (worktree ../Apex-wt-offload, off origin/main 6c122d98). Dev deploy = PR label `quick-dev-deploy` (no dev branch).

## Goal
For projects on `ai-runs-v2-transport` (prod: Apex, MaxView), App Service does no repo upkeep, no share cleanup, no repo clone, no AI agent runs. Old path stays intact for every project not on the flag. Deploys stop breaking V2 chats. Errors carry reasons.

## Constraints & decisions
- Old path must stay for all non-V2 projects (many). Never remove it; gate by the V2 flag per project.
- No new container app or job (why: cost; a job's wiped disk would re-download repos from Blob every run). Repo-read owns V2 repo upkeep: it already has the mirrors on local disk, Blob Data Contributor on `repo-grounding`, ADO/GitHub creds, DATABASE_URL, App Insights.
- App Service keeps mirror refresh + repo-cache eviction for NON-V2 projects only (why: their mirrors live on App Service's own disk `/home/data/ai-pilot/repo-cache`, not on the share; only `/home/data/ai-pilot/workspaces` is the share `ai-pilot-data`).
- Share cleanup (workspace + shared-checkout eviction) moves to repo-read; needs the share mounted in `cae-apex-repo-read-{env}` (Terraform).
- Infra, deploy workflow, prod settings need user OK per change (scope rule). User approved making the changes on 2026-11-02.
- Prod deploy target: tonight.

## Key facts (verified 2026-11-02)
- Prod `GROUNDING_MAINTENANCE_MODE=full`, `BACKGROUND_JOBS_MODE=full`, no `UV_THREADPOOL_SIZE`.
- `src/server/index.ts` starts `groundingMaintenanceScheduler` on App Service (do not edit index.ts without asking).
- Chat-host health failures line up with every new revision (17 in 7 days); Dapr logs "Aborting to hot-reload a state store component ... interactive-actor-state".
- Orchestrator loop errors Oct 30–31 = Service Bus peek-lock 500 / fetch failed; metric has no reason.
- Router clone fallback on App Service did not fire in 30 days (all PRD/test-cases used bare-mirror-read, ~4 s).

## Key files
- src/server/services/groundingMaintenanceScheduler.ts:49-59 (modes), :242-297 (sweep steps)
- src/server/services/groundingPreWarmService.ts:256-443 (refresh, bundle publish, impact enqueue)
- src/server/services/grounding/sharedReadCheckoutService.ts:382 (`retain` does not touch last-used), :399-457 (evictIdle)
- src/server/services/groundingEvictionService.ts (workspace eviction; protects DB-active groundings)
- src/server/services/backgroundWorkflowRouter.ts:737-844 (App Service mirror check / clone when V2 on)
- src/server/services/repoRead/entrypoint.ts (repo-read host; add maintenance loop here)
- src/server/services/aiOrchestrator/resultConsumer.ts:238, checkpointConsumer.ts:102 (loop_error, no reason)
- src/server/services/askApexService.ts:302-330, 612 (local Cursor agent, cwd = App Service)
- infra/repo-read-service.tf, infra/ai-runs-interactive.tf:177 (Dapr state component), scripts/ci/publish-ai-runs-interactive.sh, .github/workflows/deploy.yml:619

## Plan
Tonight (safe to test today):
1. Phase 0: confirm PR #266 live; set `UV_THREADPOOL_SIZE=32` on App Service (prod setting).
2. Phase 1a: scheduler gains a per-project filter. App Service skips pre-warm, staleness, nightly re-ground for V2-flag projects; no share eviction on App Service.
3. Phase 1b: repo-read runs the maintenance loop for V2-flag projects (tip probe, incremental fetch only on change, bundle publish, staleness) plus share eviction; deletes via rm child process; one step at a time.
4. Phase 1c: `retain` touches last-used so off-host eviction can't delete an in-use checkout.
5. Phase 1d: router with V2 on never clones on App Service and never reads App Service's mirror; sends the commit ID only.
6. Terraform: mount share in repo-read env + app; new env settings.
7. Phase 4a: promote chat-host image only when its source changed.
8. Phase 5a: loop_error metric carries reason/status.
Follow-ups 9–12 and the rest of the pending work: see "Tomorrow (2026-11-03)" below.

## Status 2026-11-03
- Prod Terraform reconciled (two forked local states merged into `Apex/infra`; tbi copy retired). Plan from main 61c7678b = no changes. Prod plan/apply needs the secret inputs from the agent-store helper `tf-merge/prd-secrets-env.sh` (Oct 9 apply passed them on the command line). #268 pins `ALLOW_TEST_ACCOUNT_SIGN_IN`/`UV_THREADPOOL_SIZE`.
- Repo vars set: `GROUNDING_MAINTENANCE_MODE_PRODUCTION=legacy-projects`, `_STAGING=disk-only`. Live slots still `full`/`cleanup-only` until the next prod deploy (user chose no restart).
- Decisions: F re-runs only PRD/design-doc assistants, Home chat, Ask Apex; B and C gate on `ai-runs-v2-transport`; A step 2 uses Postgres LISTEN/NOTIFY; C walkthrough drafts wait in place with live progress.
- In progress: all of workstream F on one branch/PR, `feat/chat-run-ended-signal` (#269, draft until F is done). Code complete, committed locally, NOT pushed (dev busy with other testing): F.0 a/b/d (server `done` on every terminal, client `endRun`, test matrix); F steps 1–3, 5–7 (reaper `lostTurnRetry` for never-started and host-lost turns — first attempt, no ADO grant, `assistant`/`home-chat`/`ask-apex`, no MCP tool call; `autoRetry` on the failed `done`; failed `done` if the re-run cannot start; `interactive.turn.auto_retry` telemetry; client "Restarting the agent…" with a 3-minute give-up). Step 5 needs no code: a drained turn stops heartbeating and takes the same path. Left: push when dev is free, dev restart test (`az containerapp revision restart` on `ca-apex-ai-agentic-dev` mid-turn), then step 4 data. A–E each get their own PR.
- Step 4 (faster lost-turn detection): prod has no heartbeat-gap history (DB keeps only the latest `heartbeat_at`; App Insights has no ingest requests or host dependencies). Done locally: `reapLostInteractiveTurns` runs every 15 s on lease `agent-run-reaper:interactive` (detection ~60–75 s, was up to ~2 min); timeout stays 60 s because heartbeats go through App Service and a restart/swap pauses them. Host sends `interactive.heartbeats` (maxGapMs, sent, failed) per durable turn. After 1–2 weeks of prod data, decide whether `AI_RUNS_INTERACTIVE_HEARTBEAT_TIMEOUT_MS` can drop to 30–45 s (look at p99 maxGapMs, especially across App Service deploys).

## Status 2026-11-04
- Workstream F done: #269 merged (99c0b724) and deployed to prod 2026-11-04 01:29 UTC. Dev tests passed: a host cut off mid-answer is detected and re-run (~1.5–2 min), the page shows "Taking longer than usual…" after 30 s of silence and "Restarting your answer…" during the re-run; a second loss or give-up shows "Error: This answer didn't finish. Please try again." + Try again, also after a reload. Technical detail stays in logs only. MCP-turn live check skipped (unit tests cover it).
- Dev test trick: `az containerapp update --termination-grace-period 5` on `ca-apex-ai-agentic-dev` (host drains on SIGTERM for 600 s, Node is PID 1 so in-container kill -9 is ignored), restart the revision while text streams, then set it back to 600 only after the re-run finishes (a revision swap also cuts off running turns). Dev is back at 600.
- Prod after deploy: all `grounding.*` events come from `ca-apex-repo-read-d4-prd` (none from `app-apex-prd`) — `legacy-projects` works. `interactive.heartbeats`: 8 turns, max gap 15.0 s, 1 turn with a failed heartbeat; no `interactive.turn.auto_retry` yet. Re-check in 1–2 weeks for the timeout decision.
- Workstream A step 1 on branch `feat/v2-validation-own-run` (off main d8144cc7), done locally:
  - No share watcher for V2 validation: `usesV2DocumentTransport` in `backgroundWorkflowRouter.ts` gates the watcher in `documentValidationService.autoStartDocumentValidation` and `designDocService.autoStartValidation`; `startupRecovery.ts` skips threads where `isV2ValidationThread` is true.
  - Own run: `listFinishedDocuments` counts only newer runs of the same `workflowClass`; new `isThreadDocumentHarvestPending` backs `canThisInstanceFailGeneration` and `getThreadRunStateSnapshot`, so a later chat turn can't hide a pending harvest.
  - Targeted tests, server typecheck and `npm run lint:check` pass.
- A step 1 pushed as PR #271 (6e3a102a).
- Decisions 2026-11-04 (user): finish A, B, C in one go, all folded into #271, then the user tests.
  - A: App Service harvests as soon as the orchestrator's terminal `done` NOTIFY arrives (`subscribeAllRunEvents`, like `playbookTerminalEventService`); the ~60 s sweep stays as a backup. Harvest stays on App Service and the orchestrator stays domain-neutral. A steps 2 and 3 dropped.
  - A step 5: same event trigger for `designPrototypeV2Harvest` and `uiLabV2Harvest`.
  - B: reuse `ai-runs-v2-transport`. Ask Apex turns lost to a host restart re-run once, same rules as Home chat.
  - C: grounding impact only; walkthrough drafts stay on App Service for now.
- Built 2026-11-04 on #271:
  - A (37db7ffc): `v2HarvestTrigger.ts` subscribes to terminal `done` events and harvests documents + prototypes under lease `ai-run-v2-harvest`; the recovery sweep takes the same lease (waits up to 30 s). Started/stopped with `startRecoveryLoop`/`stopRecoveryLoop`. UI Lab was already event-driven.
  - B (e3296470): `askApexService.openAskApexThread` creates a hidden chat thread (kickoff `askApex: true`, app-knowledge skill, project Apex) when the flag is on; `resolveInteractiveWorkflowClass` returns `ask-apex` (already eligible for one automatic re-run). History and search hide `askApex` threads. `useAskApex` switches to `useAgentChatSession` when the session has a `threadId`; the panel shows the restart / slow notice and Try again.
  - C: no code. Impact checks are started by grounding upkeep, which for V2 projects runs on repo-read (`GROUNDING_MAINTENANCE_MODE=v2-projects`). Prod and dev App Insights have zero `grounding.notification` events in 30 days.
  - Full jest: only known git/load-timeout suites fail; they pass alone. `featureRequestAnalysisService` › startWatcher › persists analysis result times out on origin/main too (pre-existing).
- Next: deploy #271 to dev; user tests a PRD or design-doc validation (scorecard lands within seconds, no `[documentValidationWatcher] Started`) and Ask Apex (answer arrives; `interactive.route.decision` workflowClass `ask-apex` route durable; thread not in Home history).
- Dev test 2026-11-04 (154c700a), PRD 6a375f78 on Apex: PRD, test cases and validation all routed to the V2 worker; App Service applied each 0.4–1.4 s after `orchestrator.result.finalized`; no `[documentValidationWatcher] Started`; validation passed.
- Follow-up found: PRD generation (`[prdWatcher]`) and test-case generation (`[testCaseWatcher]`) still start share-polling watchers on App Service for V2 runs (5 s ticks), though harvest applies their results. Same fix as A step 1.
- Dev test 2 (2026-11-04, 154c700a): design docs 2826f5c1 and 11367aec routed to the worker (`v2-commit-only`), harvest set `validating` 0.1–0.4 s after finalize, validations passed. The `[singleFeatureDocWatcher]` also ran and logged "Run terminal without complete output — marking generation_failed", but `finalizeSingleFeatureDoc` skipped (row already finalised), so no damage. Recovery also adopted doc 2826f5c1 in the 50 ms between row insert and watcher start (lease kept it to one watcher). Design doc assistant turns (workflowClass `assistant`) ran durable on `ca-apex-ai-agentic-dev`.
- Fixed (in #271): `startPrdGenerationWatcher` (prdService), `startDesignDocGenerationWatcher` (designDocService; used by createSingleFeature, routes/interviews create + retry), and the test-case route callback skip the share watcher when `usesV2DocumentTransport` is on. Recovery skips PRD, design-doc and test-case threads with a V2 run (`isV2RunThread`, renamed from `isV2ValidationThread`). In-process fallbacks still finalize through the chat post-run hook, and recovery still reattaches a watcher when no V2 run row exists.
- Ask Apex bug (fixed in #271): `useAskApex` passed `enablePreparationState: true`, so the empty Ask Apex thread (user speaks first) counted as preparing and the composer stayed locked on "Preparing…". Dropped the option.
- Seen in dev (not #271): App Service still runs repo-cache maintenance for MaxView; its mirror has a bad object (f364d692…) and repo-cache disk is 8.9 GB free of the 10 GB wanted. Belongs to workstream D/E (stop App Service repo work).
- `az monitor app-insights query -o table` prints nothing in this shell; use `-o json` piped through node to print rows. Recheck: prod `grounding.notification` in 30 days = 1 event, repo-read only, 0 AI checks; dev none.
- Dev test 3 (9de2dff2): PRD 5460a0b3, its test cases and validation, design doc 1f65989a and its validation all ran on the V2 worker with no App Service watcher; Ask Apex turns route `ask-apex` durable to `ca-apex-ai-agentic-dev` (first turn ~60 s cold). #271 merged to main (af873826) 2026-11-04; user handles the prod deploy.

## Status 2026-11-04 (after #271)
- Dev App Service had no `GROUNDING_MAINTENANCE_MODE` (so `full`); set it to `legacy-projects` with `az webapp config appsettings set` (user OK). `deploy-dev-quick.yml` does not set it, so it stays. Dev repo-read already runs `v2-projects`. App Service MaxView upkeep stopped after the 18:40:53Z restart.
- D inventory (dev, read-only):
  - No share mount: V2 document worker, V2 visual worker, orchestrator (already Blob-only).
  - Share mounted on `ca-apex-ai-agentic-*` and `ca-apex-ai-fast-interactive-*` at `/home/data/ai-pilot` (share root = App Service's `.../workspaces`), on the old `ca-apex-ai-interactive-*` at `.../workspaces`, and on repo-read at `/tmp/ai-pilot/workspaces` (repo-read mirrors are local `/tmp/ai-pilot/repo-cache`).
  - Chat host durable turns: thread workspace and grounded checkout cache are local (`os.tmpdir()` unless `AI_RUNS_INTERACTIVE_ATTEMPT_ROOT`); attachments from Blob; outputs uploaded to Blob. `openLocalBareMirrorReader` looks in `<dataRoot>/repo-cache` (on the share in the cloud, nothing writes there; it serves local dev via `scripts/dev/run-interactive-host.mjs`, a55fe586). Keep it.
  - Brainstorm source mounts are the only real chat-host share use (App Service clones catalog/temp repos onto the share; `brainstormSourceMount.candidateSourcePaths`). = old E.3.
  - App Service writes kickoff files to the thread folder on the share for every thread, and `backgroundWorkflowRouter.readDocumentScratchInputs` reads them back (plus PRD outputs for test cases) into the V2 spec. Needed; only App Service touches it. Not worth moving.
  - So D = Brainstorm repos via repo-read + Blob, then unmount the share from the V2 chat hosts (Terraform, user OK) after a dev pass.
- Old chat host `ca-apex-ai-interactive-{dev,prd}` (legacy `ai-runs-interactive` lane, Dapr app id `apex-ai-interactive`, same image as agentic): 4 replicas × 2 vCPU/4 GiB min in both envs. App Service `AI_RUNS_INTERACTIVE_DISPATCH_URL` still points at it (used only when the legacy flag is on; `interactiveWorkflowRouter` admission is legacy-only). No App Insights telemetry from it in either env (same connection-string setting name; cause unknown), no App Service dependency calls in 14 d, Requests 0–13/day. CPU: prod never above 0.27 cores in 30 d (agentic prd peaks 1.2); dev did real work Oct 28–30 (peaks 1.2–1.3) and Nov 2 14:06, idle since.
  - Prod scale: `infra/terraform.prd.tfvars` (main checkout, untracked) has `ai_runs_interactive_reserved = 4`. Proposal: set 0 there, `terraform plan` only, user applies. Keep the module: it also owns the Redis live bus (and likely the Dapr state store).
  - Dev Terraform risk (dev tfvars are with Ryan; the local file is stale, targets `rg-ai-pilot-dev`, while dev runs in `rg-scrum-dev`): `infra/terraform.tfvars` (main checkout) has `enable_ai_runs_interactive` commented (default false) though the dev app is tagged ManagedBy Terraform. A dev plan from that file would destroy the old host and Redis. Find the real dev tfvars before any dev plan.
  - Brainstorm on V2 chat hosts (code read, 2026-11-04): dev and prod App Service both set `GROUNDING_BLOB_ACCOUNT_NAME` and `REPO_READ_SERVICE_URL`, so attach publishes a Blob bundle and leaves only `.apex-brainstorm-ready` on the share; `mountBrainstormSources` finds no `.git` and checks out from the bundle (`profileId: 'brainstorm-source'`). The chat hosts need no share for Brainstorm. Not seen in telemetry: no Brainstorm turns in dev for 14 d, and chat-host console logs don't reach App Insights. App Service still clones catalog/temp repos (separate follow-up, Plan step 3).
  - Unmount: c38372a8 adds `ai_platform_v2_interactive_mount_workspace_share` (default true) and makes the volume and mount dynamic on the agentic/fast hosts. fmt + validate pass. No plan or apply. Dev tfvars are with Ryan, prod tfvars with the user. Rollout: Ryan sets `false` in dev tfvars and plans (expect only the volume/mount removal and new revisions on the two hosts; anything touching the old host or Redis = stop), then dev test (Ask Apex on a design doc, chat with attachment, Brainstorm with a catalog repo and a temp repo), then the user does prod.
  - User 2026-11-04: `ai-runs-interactive` is ON in dev and prod. Do not scale the old host to 0: chats for non-V2 projects (flag-off/error path of `ai-runs-v2-transport`) can still go to it through `AI_RUNS_INTERACTIVE_DISPATCH_URL`. Next: find who the flag targets and how many legacy actor turns run (`interactive.route.decision` route `actor`), then either move those projects to V2 or lower the floor to 1–2.

## Status 2026-11-05
- Dev and prod: share unmounted from the agentic and fast-interactive hosts (dev by `az rest` PATCH 2026-11-05; prod by targeted `terraform apply`, state `infra/terraform.tfstate.d/prd/terraform.tfstate` in the main checkout, backup `terraform.tfstate.pre-unmount-20261105T1935Z.backup`; `terraform.prd.tfvars` has `ai_platform_v2_interactive_mount_workspace_share = false`). Ryan still has to add the same line to the dev tfvars.
- A full prod plan from an agent shell is unsafe: without the user's `TF_VAR_*` secrets it errors on `github_token` (main.tf:130) and plans to rewrite the repo-read secrets. Use `-target` for narrow changes, or have the user run it.
- `ai-runs-interactive` flag: off in dev (verified, all turns durable); user to turn off in prod. Every project it targeted (Apex, MaxView, MatterWorx, Amego) is on `ai-runs-v2-transport`, and the legacy router only runs when V2 is off.
- #273 merged and in prod: `defaultResolveGrounding` skips App Service's checkout for whole-V2 projects with `repo-read-service` on and `REPO_READ_SERVICE_URL` set (lightweight pin). Dev Ask Apex: handover ~1 s, total ~12 s.
- Prod `resource_exhausted` from the Cursor SDK 18:50–18:59Z on one Brainstorm thread and App Service: Cursor account/API limit, not our change. Cleared by 19:31Z.
- Blob: `stapexprdasync` ~40 GiB flat, 1,505 blobs (from 240 in a month). Lifecycle rules cover `repo-grounding/` (14 d last access), `cursor-prompts/` (1 d), load tests (90 d); the V2 artifact container has none. Follow-up: add a rule to `lt_artifacts_lifecycle` after checking nothing reads old V2 artifacts.

## Workstream F: V2 document scratch inputs from the DB (branch `feat/v2-scratch-inputs-from-db`)
Goal: V2 document runs stop reading `.ai-pilot/*` from the share. Only `backgroundWorkflowRouter.readDocumentScratchInputs` reads them (V2 chats already use `thread.kickoff` from the DB).
- What the files hold today:
  - `kickoff-context.md` = `kickoff.freeformContext` (DB) when written by `injectKickoffFiles` or by routes that also call `updateThreadKickoffContext`. Some writers update the file only (check each): `testCaseService.ts` ~974, `adoTestCaseSuiteService.ts` ~1891, `designDocService.ts` ~2404/2420, `qaCaseRegenerationService.ts` ~487, `qaLabAssistantService.ts` ~289, and the assistant-thread refreshes in `routes/interviews.ts` ~1485/2532, `routes/api.ts` ~4747, `routes/adr.ts` ~529.
  - `kickoff-transcript.md` = `kickoff.transcript`; `session.json` is built in `injectKickoffFiles` from threadId + kickoff.
  - test-cases: `.ai-pilot/output/<slug>.prd.md` + `.backlog.json` written by `testCaseService` from the PRD row.
  - QA Lab: `test-plans.md`, `existing-test-cases.json`, `test-case-index.md` written by `adoTestCaseSuiteService` from ADO at thread start (only copy).
- Design:
  1. `PreparedBackgroundWorkflowTurn` gains optional `scratchInputs`. When V2 and it is set, the router uses it and skips the disk read; legacy keeps the files.
  2. `prepareBackgroundWorkflowTurn` builds the base set from the thread: context, session (shared `buildSessionMarker` with `injectKickoffFiles`), transcript for prd/adr. Filtered by `isAllowedDocumentScratchInputPath`.
  3. Writers that change `kickoff-context.md` for document runs also call `updateThreadKickoffContext` so DB and file agree.
  4. test-cases prepare adds PRD/backlog from the PRD row; QA Lab uploads its three files to Blob at write time and reads them back in prepare (user choice: Blob).
  5. Assistant-thread context refreshes (file only today) also update the DB; V2 chats read the DB, so they currently see the context from thread creation. Verify before fixing.
  6. Later, separate: stop writing these files to the share for V2 projects.
- Also found: V2 document prepare still waits on App Service grounding (`waitForReadyThreadGrounding` in `prepareBackgroundWorkflowTurn`), same cost #273 removed for chats. Follow-up.

### Status 2026-11-06 (PR #277, all on one branch)
- Done (uncommitted until pushed): scratch inputs from DB + Blob snapshot `document-inputs/<threadId>.json` (`aiRunV2/documentInputSnapshot.ts`), router `resolveDocumentScratchInputs` (records → snapshot → share only if required inputs missing; event `background.scratch-inputs.source`); ingest saves the interview transcript to the DB; whole-V2 document prepare skips the checkout via `findTargetGrounding` + `RepoServiceReader` (`repoRead/wholeProjectRepoRead.ts`, shared with durable chats); Brainstorm readiness from the row (`isSourceServedRemotely`), no `.apex-brainstorm-ready` markers; Terraform rule `ai-run-artifacts-30day` in `infra/load-test.tf`.
- Verified: 34 affected suites pass (documentValidationService times out only under full parallel load; passes alone), server + client tsc, lint 0 errors.
- After prod deploy (user must ask): set `ai_runs_interactive_reserved = 0` in main checkout `infra/terraform.prd.tfvars`, targeted plan/apply on `azurerm_container_app.ai_runs_interactive` and `azurerm_storage_management_policy.lt_artifacts_lifecycle`. Keep the module (it owns Redis/Dapr components the V2 hosts use).
- Ryan (dev tfvars): `ai_platform_v2_interactive_mount_workspace_share = false`, later `ai_runs_interactive_reserved = 0`.
- Follow-up PR: stop App Service writing V2 thread files to the share.
- 2026-11-07: #277 also has 899b5f54 (reuse an active chat pin, no 23505; snapshot read only for test-cases) and 13974986 (lifecycle rule removed; #277 now has no Terraform).
- Next PR (user-approved scope), branch off main after #277 merges:
  1. Stop App Service writing V2 thread files to the share.
  2. Brainstorm temporary repos: App Service still fetches depth-1 into os.tmpdir, bundles, uploads, deletes (`gitSourceClone.ts` `cloneTemporaryAtSha`, called from `sourceWorkspaceManager.completeTemporaryClone`). Move to the worker or repo-read. Catalog repos already skip the clone when `REPO_READ_SERVICE_URL` is set.
  3. Lifecycle rule `ai-run-artifacts-30day` in `infra/load-test.tf`, prefixes `runs/`, `document-inputs/`, `interactive/` only. Never `workflow-evaluations/` (corrected artifacts, DB keeps only the blob ref). Azure prefix_match is include-only.
  4. Old interactive host to 0 warm replicas (user-approved 2026-11-07, ships with this PR): set `ai_runs_interactive_reserved = 0` in the main checkout's `infra/terraform.prd.tfvars` (untracked, never committed), then targeted plan, show the user, apply only on approval: `-target=azurerm_container_app.ai_runs_interactive` plus `-target=azurerm_storage_management_policy.lt_artifacts_lifecycle` for item 3. Keep the module (Redis/Dapr components the V2 hosts use). App Service `AI_RUNS_INTERACTIVE_RESERVED` only feeds `interactiveActorAdmissionService` on the old path (flag `ai-runs-interactive` off), so it can stay. Dev: Ryan sets the same in dev tfvars.
  - Branch `feat/v2-share-writes-off` (off main 74aee109). Item 3 edited in `infra/load-test.tf` (uncommitted, fmt ok; policy account = V2 container account, stapexprdasync).
  - Item 1 map (2026-11-07, all under src/server/):
    - Blocker: durable chat completion writes outputs to the share: `aiRunIngestService.ts` ~946 → `interactiveArtifactApplier.ts` `applyInteractiveArtifacts`. Readers: walkthroughGenerationService ~681, walkthroughAnchorDiscoveryService ~359, designModuleScopingService ~200/400, loadTestAiGenerationService ~168, featureRequestAnalysisService ~255/377, designModuleService ~380, chatAgentService `readOutputPrd`/`readOutputBacklog` (`resolveOutputDir` ~7177) via routes/chat.ts ~1025 and routes/interviews.ts ~1083/2247/2704.
    - Unconditional writers: createThread ~3078 + loadThread recreate ~2935 (`injectKickoffFiles`); `clearBackgroundGenerationOutput` in the V2 router path (~745, ~814); linked-context doc (runGroundingService ~449 → linkedContextMaterializerService ~414, not in V2 allow-list); assistant context rewrites (routes/interviews.ts 1495/1522/2544/2579, routes/adr.ts 528/565, routes/api.ts 4754, designDocService 2398/2436); testCaseService 959; adoTestCaseSuiteService 473/1780/1892; qaCaseRegenerationService 179/485 (no snapshot, always share fallback); qaLabAssistantService 77/95/461.
    - No try/catch (ENOENT → 500 if folder missing): interviews.ts 1523, 2580; adr.ts 565; designDocService 2399.
    - ADO suite watcher not V2-gated (adoTestCaseSuiteService 534, 1911-1962).
    - Gap: QA Lab assistant `test-plans.md` never reaches the V2 chat host.
    - In-process agents on App Service (not share): model probe, walkthroughAiDraftService ~136, groundingImpactEvaluatorService ~238.
  - Item 2 constraint: worker only checks out Blob bundles / repo-read; repo-read has only read/list/search for known identities (`repoRead/entrypoint.ts`).
  - Optional: dev deploy copies `.cursor/skills/brainstorm` (`deploy-dev-quick.yml`), needs user OK (CI file).
  - Status 2026-11-07 (uncommitted on `feat/v2-share-writes-off`): items 1–3 and the three small fixes are coded; tsc, lint, codemap pass; targeted tests pass.
    - Item 1: migration `20261107210000_v2to01_chat-thread-outputs.sql`, `chatThreadOutputStore.ts` (read DB first, then folder), `threadFolder.ts` (`keepsThreadFolder` = not whole-V2; lookup error keeps the folder). Ingest saves to DB, writes the share only when the folder is kept. All readers above use the store. Writers go through `writeThreadFolderFile`. Try-wrapped refreshes (adr reuse, designDocService ~2436, api.ts 4754) left alone.
    - Item 2: `POST /v1/publish-bundle` on repo-read (`repoRead/publishBundleHandler.ts`, re-checks URL + DNS); `cloneTemporaryAtSha` calls it when `REPO_READ_SERVICE_URL` is set, else `publishTemporaryCloneBundle` locally. No infra change: repo-read already has GITHUB_TOKEN, ADO_ORG/ADO_PAT and Blob Contributor on `repo-grounding`. Container Apps ingress timeout is 240 s; a very large repo could hit it.
    - Small fixes: ADO suite and case-regeneration share watchers skip V2 (harvest applies results); regeneration saves `test-plans.md` to the Blob snapshot; QA Lab assistant inlines the Test Plan list in its kickoff context (no `test-plans.md` file).
    - Full suite: only `featureRequestAnalysisService` "persists analysis result" (also fails on main, 5 s timeout on a cold dynamic import) and `repoCacheGitIntegration` compaction (untouched code) fail.
    - Next: commit, push, open PR; after prod deploy item 4 + targeted plan (approval needed).
- Findings to report: QA case regeneration on V2 has no prd/backlog inputs (predates this); PRD context lacks comment IDs.

## Tomorrow (2026-11-03)
Start a new branch off main after tonight's merge. Each workstream ships on its own PR, flag-gated per project, old path kept for non-V2 projects. Dev soak each one before prod. Order is by risk removed per unit of work.

Where V2 work runs today (target in brackets):
- Request intake, flag check, execution spec, outbox row: App Service [stays: `.cursor/rules/v2-worker-no-policy.mdc`]
- Dispatch, checkpoints, terminal results: orchestrator [stays]
- Document harvest (`documentV2Harvest`, `startupRecovery.ts:343`, ~60 s sweep) and the validation watcher: App Service [orchestrator, workstream A]
- Ask Apex agent process (`askApexService.ts`, cwd = App Service): App Service [V2 agentic host, B]
- Walkthrough drafts (`walkthroughAiDraftService.generateProposal`/`generateStepProposal`), grounding impact (`groundingImpactEvaluatorService.evaluateWithCursorSdk`): App Service [V2 document lane, C]
- Chat hosts and workers: share `ai-pilot-data` for workspaces and `.ai-pilot` files [local disk + Blob, D]

A. Harvest + validation to the orchestrator (fixes the last 0% cause)
Blockers found 2026-11-02 (why not tonight):
- `syncOutputToDb` → `notifyAiCompletion` pushes through `notificationService.ts` in-memory `connections` Map on App Service. From the orchestrator the row is saved but no open browser hears it.
- `syncOutputToDb` starts follow-on jobs (`triggerTestCaseGeneration`, `autoStartPrdValidation` → `startDocumentValidationWatcher`, an in-process `setInterval` that reads the share via `readOutputValidationScorecard`/`isOutputWorkspaceReadable`). The orchestrator has no share mount.
- `documentV2Harvest.ts` header: the orchestrator is meant to stay domain-neutral.
Steps:
1. Quick win first (own PR): for V2 validation threads, do not start the share watcher; harvest already ingests the scorecard via `syncOutputToDb` → `ingestValidationScorecard`. Harvest and `canThisInstanceFailGeneration` pick the document's own run (`prds.validation_thread_id` / `design_docs.validation_thread_id` run), not the thread's newest run (`finishedAttemptReader.listFinishedDocuments` `NOT EXISTS newer`). Test: a chat run after the validation run must not hide it.
2. Cross-process events: Postgres `LISTEN/NOTIFY` (or Service Bus topic) so any process can publish notifications and thread events and App Service fans them out to its SSE connections. Verify payload size limits (NOTIFY 8 KB; send ids only).
3. Follow-on job starts go through the outbox (App Service resolves the spec when it consumes the request), not an in-process call.
4. Move the harvest call into the orchestrator result consumer after `transitionAttempt` (finished attempt known at that moment); keep App Service's sweep as a fallback behind the flag for one sprint.
5. Same for `designPrototypeV2Harvest` and `uiLabV2Harvest` (`startupRecovery.ts:750,766`).
Done when: V2 validation reaches the DB in < 10 s after the worker finishes, alerts still arrive live, App Service logs no `[documentValidationWatcher] Started` for V2 projects.

B. Ask Apex on the V2 agentic host
1. Ask Apex already reads through repo-read (818ee7d4, per-session `sandboxCwd`). Move the agent run to the interactive actor host like Home chat: route Ask Apex sessions through `durableInteractiveTurnService` when the project is whole-V2.
2. Keep the app-knowledge skill and context pack; the host needs the skill file and the repo docs (`context.md`, `AGENTS.md`, design docs) from repo-read, not App Service's disk.
3. Flag: new per-project flag (feature-flags skill) or reuse `ai-runs-v2-transport`; ask the user.
Done when: App Insights shows Ask Apex turns dispatched to `ca-apex-ai-agentic-{env}` for Apex/MaxView and no local Cursor agent process on App Service.

C. Walkthrough drafts + grounding impact on the V2 document lane
1. Add workflow classes to `BackgroundWorkflowClass` (exhaustive switches in `documentV2Harvest.ts` and the worker's `assertExpectedOutputSet` will flag every place to handle).
2. Output contract: one JSON file each in `.ai-pilot/output`; harvest applies it (pattern: `walkthrough-smart-tagging`).
3. Router builds `scratchInputs` (catalog anchors for drafts; diff/commit range for impact).
4. Drafts are user-facing and synchronous today: decide with the user whether the UI waits on a run (progress like the assistants) or polls.
Done when: no Cursor SDK calls from App Service for these two on V2 projects.

D. Blob + local disk (old item 11; also `../Apex/.cursor/plans/grounding-local-disk.md` Phase 2)
1. Inventory every share read/write for V2 runs: `interactiveActorHost/entrypoint.ts`, `interactiveSessionActor.ts` (`reclaimDisk`), `brainstormSourceMount.ts`, `chatAgentService.hydrateThread`, `.ai-pilot` transcript/kickoff files, documents-v2 worker inputs.
2. Grounding: execution spec carries provider/project/repo/sha only; each host materializes on its own local disk from the Blob bundle (`bundleStoreService.rehydrate`) or repo-read.
3. `.ai-pilot` files (kickoff transcript, outputs, scorecards): DB for small text, Blob for the rest; App Service reads DB/Blob, never the share, for V2 threads.
4. Chat-host thread workspace: local disk, rebuilt from DB/Blob on actor activation; idle eviction stays local.
5. Remove the share mount from V2 hosts only after two clean sprints; keep it for non-V2.
Done when: V2 hosts run with the share unmounted on dev for a full test pass (PRD, design doc, test cases, validation, chat, Brainstorm).

E. Smaller items
1. Chat-host zero-downtime swap (old item 10): multiple revisions, shift traffic after Dapr ready; stop the Dapr state component hot-reload (`infra/ai-runs-interactive.tf:177`).
2. Alerting (old item 12): route-decision event for every AI entry; alert on `grounding.v2_app_service_fallback` and any App Service repo/AI work for a V2 project.
3. Brainstorm catalog repos and temp repos: on-demand bundle publish by repo-read instead of cloning on App Service.
4. Agentic host restart mid-turn (dev 2026-11-03 00:33:43Z, thread 498515d8, run 4525e179): container restartCount 1, no error logged, memory normal; probes allow 1 s while `/health` awaited a Dapr metadata fetch with a 2 s timeout. Shipped tonight: `createCachedHealthCheck` (answers from the last report) only. Client-side failure/restart UI was built and reverted the same night (see F.0). Still to do:
   Automatic re-run on restart and faster loss detection: workstream F. Confirm restart reason: dev Container Apps env sends logs to `azure-monitor` with no workspace attached, so system logs (probe failures, OOM) are not kept; ask the user before adding a diagnostic setting (infra).

F. Automatic retry when a chat host restarts mid-turn
Goal: a turn lost to a host restart, deploy, or crash re-runs once on its own; the user sees "Restarting…" and then the answer. The error + Try again (shipped 32e5850d) appears only when the re-run also fails or is not safe.
Today: `agentRunReaperService.ts` retries once only for durable turns still `dispatched` past the start budget (`neverStartedTurnRetry`, eligible when the run has exactly one attempt and `specification.toolGrant === null`; retry = `durableInteractiveTurnService.retry`). A `running` turn whose heartbeat stops (`DEFAULT_DURABLE_INTERACTIVE_HEARTBEAT_TIMEOUT_MS` 60 s) is failed with "Interactive agent stopped responding. Please retry." and no retry. Dev case took ~1m45s from restart to failure.
Steps:
0. Do this first. Tonight's client fixes (32e5850d, 9604d70f, e2c719aa) were reverted because each patched one terminal path and Bugbot found the next gap three times (missed health-only reaper terminals; give-up timer keyed on a new run id though `durableInteractiveTurnRepository.retry` reuses the run id; failed health left status `running`, so the composer and Try again stayed disabled). A failed turn is silent in every chat today (pre-existing). Rebuild in this order:
   a. Server: one terminal signal. The reaper's `markTerminal` → `finalizeAgentRun` (`pgNotifyService.ts`) fans out only the passed `health` event; make every terminal publish a `done` envelope with `status` + `detail` (orchestrator already does via `applyTerminalRunEffects`, `terminalEventsPersisted: false`). Keep the health event for run-health UI.
   b. Client: one `onRunEnded(runId, outcome, detail)` in `useChatStream` used by every ending: in-turn `done`/`error`, orchestrator `done` failed, reaper `done` failed, `status` broadcast, poll snapshot (`data.status`/`lastError`). It resets everything `done` resets today (status → idle, stream buffer, thinking, tool progress, progress label/phase, poll timer, awaiting state), then picks error + `retryableRunId` or "Restarting the agent…".
   c. Restart state: keyed on the attempt, not the run (a retry reuses the run id); clear on any progress after the restart; give-up fallback shows the error and leaves the composer enabled.
   d. Test matrix: every ending above × {completed, failed, auto re-queued} × {event-driven termination on, off}. Assert status, composer enabled, `retryFailedRun` callable, one error message, no stale partial reply.
   e. UI: `AssistantConversation` error line + Try again (`onRetry`), restarting line (`isWorking || isRetrying`); same for Home and ADR.
   f. Dev check: restart `ca-apex-ai-agentic-dev` mid-turn and confirm the answer, then a non-retryable turn shows error + working Try again.
1. Shared constant for the reaper's "re-queued" detail (`INTERACTIVE_AUTO_RETRY_DETAIL`), or better a structured field on the `done` envelope (`autoRetried: true`) so the client does not compare strings.
2. Extend eligibility to `running` turns lost to a dead host (rename to `lostTurnRetry`). Safe when all hold:
   - first attempt only (one automatic re-run per user message; `ai_run_attempts` count = 1);
   - `toolGrant === null` (no delegated ADO token);
   - no external write happened in the lost attempt: no tool event for an MCP/ADO write in `agent_run_events` (list the write tools; read-only tools are fine);
   - the workflow applies its edits only at turn end (PRD/design-doc assistants, Home chat, Ask Apex). Check ADR and interview turns before including them.
   Not eligible → today's error + Try again.
3. Re-run from the same user message; do not post a second user bubble. Clear the partial streamed text of the lost attempt on the client (`retrying` event resets `streamingText`).
4. Faster detection: on startup the interactive host lists runs it owned (`agent_runs` running on lane `ai-runs-interactive`, dapr-actor-v2, heartbeat older than its start time) and hands them to the same retry path, instead of waiting for the heartbeat timeout plus the reaper sweep. Lower the heartbeat timeout only if heartbeats are reliable (check `heartbeatAt` gaps in prod first).
5. Deploys: a planned restart (new revision) drains first (`createInteractiveShutdownDrain`); turns still running at drain timeout take the same retry path. Ties in with E.1 (zero-downtime swap).
6. Telemetry: `interactive.turn.auto_retry` {reason: never_started | host_lost | deploy, eligible, skippedReason}; alert when auto-retries exceed N/hour (a host in a restart loop).
7. Tests: reaper unit tests for each eligibility rule; client test that a retried run shows "Restarting…" and no error; dev check by restarting the agentic container mid-turn (`az containerapp revision restart`) and confirming the answer arrives.
Done when: on dev, restarting the agentic host mid-turn produces the answer with no error for PRD/design-doc assistant and Home chat turns, and a turn with an ADO write shows error + Try again instead of re-running.
5. Prod Oct 27 "no scorecard": check whether a chat run landed on the validation thread (same query as dev a65426dd, read-only via Kudu).
6. ADR assistant UI: move to `AssistantConversation` like the PRD and design-doc assistants.

Questions for the user before starting:
- F step 2: which turn types are allowed to re-run on their own (proposal: PRD/design-doc assistants, Home chat, Ask Apex; not ADR or interviews until checked)?
- Which flag gates B and C (new per-project flag or `ai-runs-v2-transport`)?
- A step 2: Postgres `LISTEN/NOTIFY` or a Service Bus topic for cross-process events?
- C step 4: should walkthrough drafts wait in the UI with live progress?

## Done
- [x] Prod investigation (see Key facts)
- [x] Worktree + branch created
- [x] User agreed: repo-read owns upkeep, no new container app
- [x] Items 2–5, 8: scheduler modes `legacy-projects` / `v2-projects` / `disk-only`, whole-project flag check, retain heartbeat, router commit-only for V2, loop_error reason
- [x] Item 6: repo-read Terraform (share mount at `/tmp/ai-pilot/workspaces`, `GROUNDING_MAINTENANCE_MODE=v2-projects`, `CURSOR_API_KEY` from Key Vault, `UV_THREADPOOL_SIZE=16`); fmt + validate pass
- [x] Item 1: deploy.yml reads `vars.GROUNDING_MAINTENANCE_MODE_PRODUCTION` (default `full`) and `_STAGING` (default `cleanup-only`); prod gets `UV_THREADPOOL_SIZE=32`
- [x] Tests (146), tsc, lint, repo-read entrypoint load all pass
- Item 7 deferred: promotion is already change-gated, but chat hosts bundle all of `src/server/`, so any server change restarts them. Real fix is item 10.

- [x] PR #267 deployed to dev (692a75f3). Dev Terraform state is not on this machine, so dev repo-read was updated with `az containerapp secret set` + `az containerapp update --yaml` (same shape as the Terraform). Revision `ca-apex-repo-read-dev--0000144` logs `grounding maintenance started (mode=v2-projects)` and does prewarm, staleness, bundle publish and both evictions for Apex and MaxView (45 share folders seen, all protected).
- Dev findings: MaxView branch `tbi/55352-phase-3-service-now-cab-ticket` was deleted in ADO; pre-warm fails on it every sweep on both hosts (pre-existing, other targets still run). App Service's own MaxView@development mirror fails fetch with `bad object`; repo-read's copy is fine. A local orchestrator on host MSL-SD00F6QZ is running against dev and taking interactive runs.
- Dev test 1 (MaxView PRD 8b0908b9, 18:09Z) failed `grounding-unavailable`: `callerGroundingService` first turn fetches App Service's own mirror to pin; dev App Service MaxView mirror lost a pack (879/964 refs missing, since 17:15Z) and can't re-clone (dev /home is 10 GB, guard needs 10 GB free). Fix 7515f4df: when grounding fails for a whole-V2 project with no pin, pin the `ls-remote` tip (event `grounding.v2_remote_tip_pin`). Follow-up: skip App Service mirror entirely for V2 runs.
- 89625795: commit-only grounding. `callerGroundingService` for whole-V2 projects (+ `repo-read-service` flag, `REPO_READ_SERVICE_URL`, sandboxCwd, native-read) pins existing/ls-remote tip, profile has no mirror (reads via `RepoServiceReader`), no App Service bundle publish. Covers background runs AND durable chat admission (`durableInteractiveTurnService.defaultResolveGrounding`), which also used App Service's mirror and silently lost grounding when it broke.
- Mirror damage cause (dev): pack deleted ~16:50Z, read-only idx/rev left, empty packed-refs; most likely a partial whole-mirror delete on SMB /home. Not proven: dev App Service sent no telemetry before 17:15Z; prod App Service sends no traces at all. Prod mirrors checked read-only via Kudu: 0 orphan packs, 240 GB free.
- Flags checked read-only in both DBs (Kudu node query, 2026-11-02): Apex + MaxView have project rules for `ai-runs-v2-transport`, `native-read`, `repo-read-service`; `project-repository-checkout-readiness` is disabled in both envs. So prod takes commit-only.
- Fallback event: `grounding.v2_app_service_fallback` (reason `v2-flag-check-failed` | `native-read-off` | `repo-read-unavailable` | `no-sandbox` | `repo-read-url-missing` | `repo-read-off` | `repo-read-flag-check-failed`) whenever a whole-V2 project lands on App Service's mirror. Interactive legacy on flag error is already `interactive.route.decision` reason `flag-evaluation-error`.
- Ask Apex passes a per-session `sandboxCwd` (never created, `os.tmpdir()/ask-apex-sessions/<id>`), so it now takes commit-only too.
- Bugbot fixes: commit-only is resolved before the checkout-readiness block and skips it (flag is off today, but would have pulled V2 runs back onto App Service). `isFlagEnabledForWholeProject` now returns false when the flag has any `environment` rule, because repo-read resolves `local` (no APP_ENV/WEBSITE_SITE_NAME) and prod App Service also resolves `local` (`app-apex-prd` has no "prod"), so hosts could disagree.
- Merged main (PR #262 Brainstorm). For whole-V2 projects Brainstorm no longer reads App Service's mirror: commit choice skips `readCachedOriginSha` in `brainstormOrchestrationService` default sources, `routes/brainstormSources` resolveProjectSource and `durableInteractiveTurnService` lightweight fallback; attach of a project repo without a published bundle uses `brainstorm/projectCommitClone.ts` (remote depth-1 fetch into os.tmpdir + bundle publish) instead of cloning App Service's mirror. Catalog repos (feature-owned clones) and external temp repos still clone on App Service, for every project (follow-up: repo-read on-demand bundle publish).
- Full jest on the merge: 901/907 suites pass; the 6 failures (git integration, aiRunsWorker, nativeReadReadPath) pass alone — load timeouts.
- Dev PRD 8e5a98b0 validation 0% (pre-existing, not offload): V2 worker wrote both scorecards (run completed 20:53:00), but a Home chat turn landed on validation thread a65426dd at 20:53:27. Harvester (`finishedAttemptReader.listFinishedDocuments`) only takes each thread's newest run, and the watcher's `canThisInstanceFailGeneration` checks the newest run's pending harvest, so the chat run hid the finished validation and the watcher recorded "no scorecard". History listed the thread because `listThreadsByUser` hid only interview/PRD/brainstorm threads. Fix: `chatThreadRepository.isBackgroundWorkflowThread` (prds.validation_thread_id, design_docs.chat_thread_id/validation_thread_id, test_cases.chat_thread_id); history + search hide those threads; `POST /threads/:id/messages` returns 409 `BACKGROUND_WORKFLOW_THREAD`. Follow-up: make harvest/watcher look at the document run, not the newest run. Prod Oct 27 V2 validation "no scorecard" cause still unconfirmed.
- Background-thread check also covers ADR generation (`adrs.generation_thread_id`) and earlier job threads by kickoff heading (re-runs drop the table reference). Dev re-run of PRD 8e5a98b0 validation: 87%, `pending_review`.
- PRD and design-doc assistants (user asked, same branch): server no longer runs the PRD "introduce yourself" turn; both panels use `agentChat/AssistantConversation` (welcome + suggested prompts that fill the composer, Home-style replies, `ChatRunProgressLabel` step line instead of typing dots).
- Known failing before this work: `repoCacheGitIntegration` › compactRepoCache times out at 5 s locally (same on base).
- Dev watchers live in the agent store `dev-watch/` (`watch-appinsights.sh` → `appinsights.log`, `watch-containerlogs.sh` → `ca-*.log`).

## Next
1. User tests on dev MaxView (PRD, design doc, test cases, chat, interview; non-V2 control). Then set dev App Service `GROUNDING_MAINTENANCE_MODE=legacy-projects` and re-test.
2. Prod rollout tonight, in order:
   a. Merge, deploy (App Service still `full` — safe overlap; leases are per mode, so both may refresh V2 mirrors for one night).
   b. `terraform apply` for repo-read (user must ask explicitly).
   c. Confirm repo-read logs + `grounding.*` events from repo-read.
   d. Set repo vars `GROUNDING_MAINTENANCE_MODE_PRODUCTION=legacy-projects`, `GROUNDING_MAINTENANCE_MODE_STAGING=disk-only`; set the same on the live slots with `az webapp config appsettings set --slot-settings` (or re-run deploy).
   e. Rollback: delete the vars / set `full` again.

## Mistakes to avoid (learned in earlier chats)
- App Insights KQL via az CLI: don't use `last`, `kind` as column aliases (BadArgumentError).
- Don't assume the full clone fallback is firing; telemetry shows bare-mirror-read.
- Orchestrator "restarts" were clean exits on deploy, not crashes.
- User works on another branch in the main checkout; work only in ../Apex-wt-offload.
- No `dev` branch exists; dev deploys via PR label.

## Verify with
- `npx jest src/server/__tests__/<file> --silent`
- `npx tsc -p tsconfig.server.json --noEmit`
- `npm run lint:check`
- Prod after deploy: App Insights `grounding.*` events from `app-apex-prd` for Apex/MaxView = 0.

## Open questions for the user
- Approval for prod `terraform apply` of repo-read changes.
