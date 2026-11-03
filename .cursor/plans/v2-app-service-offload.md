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
4. Agentic host restart mid-turn (dev 2026-11-03 00:33:43Z, thread 498515d8, run 4525e179): container restartCount 1, no error logged, memory normal; probes allow 1 s while `/health` awaited a Dapr metadata fetch with a 2 s timeout. Shipped tonight: `createCachedHealthCheck` (answers from the last report) and the client shows failures from `semanticStatus: 'failed'` on done (reaper/orchestrator terminals were silent) with Try again in the assistants. Still to do:
   a. Auto re-run a turn lost to a host restart once (extend `neverStartedTurnRetry` in `agentRunReaperService.ts` to started-but-lost turns with no external side effects; Apex applies assistant edits only at turn end). Error + retry only if the re-run fails.
   b. Faster loss detection: the restarted host reports its lost runs at startup instead of waiting for the 60 s heartbeat timeout plus the sweep (took ~1m45s).
   c. Confirm restart reason: dev Container Apps env sends logs to `azure-monitor` with no workspace attached, so system logs (probe failures, OOM) are not kept.
5. Prod Oct 27 "no scorecard": check whether a chat run landed on the validation thread (same query as dev a65426dd, read-only via Kudu).
6. ADR assistant UI: move to `AssistantConversation` like the PRD and design-doc assistants.

Questions for the user before starting:
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
