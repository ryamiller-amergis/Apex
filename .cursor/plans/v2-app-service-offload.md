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
Follow-ups (not safe for tonight; need design + dev soak):
9. Phase 3: Ask Apex → V2 agentic host; walkthrough drafts + grounding impact → V2 document lane (flag-gated, old path kept).
10. Phase 4b: zero-downtime chat-host swap (multiple revisions, shift traffic after Dapr ready); stop Dapr state component hot-reload.
11. Phase 2: V2 chat hosts off the share onto local disk + Blob; `.ai-pilot` files to DB/Blob.
12. Phase 5b: route-decision event for every AI entry; alert when App Service does repo/AI work for a V2 project.

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
