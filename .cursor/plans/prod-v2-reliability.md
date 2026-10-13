# Prod V2 reliability (Oct 13 incidents)
Updated: 2026-10-13. Repo: Apex. Branch: fix/prod-v2-reliability (from origin/main 9afd20b6)

## Goal
Fix the four prod failures from Oct 12–13 and make the next one page Aneesh instead of a user:
1. ADR finalize stuck `generating` (ADR 356f848d…, finalize thread f2b544c5…): no message, no run.
2. Interview turns hung on agentic replica zvvv5 (Dapr sidecar lost after app restart); `/health` said ok.
3. MaxView interview got a poor guided question + lone "Skip — decide later".
4. App Service `/home` (250 GB, shared by prod + staging slot) filled with repo cache; clones failed.

## Constraints & decisions
- No `terraform apply`; user deploys. Edit code + Terraform + this file only.
- Alerts email anedunur@amergis.com only (one action group).
- Container logs stay OFF in prod (`enable_ai_platform_v2_container_logs=false`), so Dapr/mount alerts come from metrics + App Insights, not ContainerAppSystemLogs.
- ADR generation moves to the V2 background document lane (like test cases). Legacy watcher stays only for V2-off.
- When `ai-runs-v2-transport` is on, V2 owns the path: skip `project-repository-checkout-readiness` pre-check in the ADR route; check `maxview-mcp` only for workflows that use MaxView tools (not ADR).
- Immediate ops step for user: turn `playbook-interview-step` OFF for the MaxView project in Platform Admin.

## Root causes (evidence)
- ADR assistant AND finalize (confirmed in prod App Service logs): `INTERACTIVE_V2_SKILL_UNAVAILABLE`. Project settings store `.agents/skills/adr-*/SKILL.md`, but on main the files live in `.cursor/skills/adr-*`. Legacy `sendMessage` tries every root via `skillPathCandidates`; V2 `loadDurableInteractiveSkill` read only the stored path. Fixed: V2 now tries all roots.
- ADR (secondary): `routes/adr.ts` POST `/:id/generate` calls `createThread(...kickoffMessage)`; `createThread` fires `sendMessage` via `setImmediate` (chatAgentService.ts ~2981) BEFORE the route runs `propagatePipelineGrounding`. V2 admit can throw (grounding/skill/maxview 422) and the `.catch` only `console.error`s. ADR completion relies on in-memory `startAdrWatcher` polling App Service local output (adrService.ts ~361).
- No ADR requests or kickoff logs exist in App Insights `appi-app-apex-prd` for Oct 13 → App Service telemetry gap.
- Worker health: `registerInteractiveHealthHandler` (interactiveActorHost/entrypoint.ts ~185) returns ok unconditionally; all three probes hit `/health` (infra/ai-platform-v2-interactive-runtime.tf ~322).
- Reaper (agentRunReaperService.ts ~900-940) marks never-started durable turns `worker_lost` with no retry.
- `guidedInterviewState.ts` ~435 appends Skip even to open questions.
- Disk: only `cleanupStaleWorkspaces()` (chatAgentService.ts ~392) at startup; repo cache under `/home/data/ai-pilot` never evicted. Azure Files share `ai-pilot-data` is 100 GB / 5.4 GB used (not the full disk).

## Key files
- src/server/routes/adr.ts:226-325 generate route
- src/server/services/testCaseService.ts:718-787 pattern: `routeBackgroundWorkflow` + propagation inside `prepareWorker`
- src/shared/types/backgroundWorkflow.ts, src/shared/types/aiRunV2DocumentSpec.ts, src/server/services/aiRunsV2Worker/documentExecution.ts, src/server/services/aiRunV2/finishedAttemptReader.ts, src/server/services/documentV2Harvest.ts, src/server/services/repositoryPreparationService.ts, src/server/services/backgroundWorkflowRouter.ts: 'test-cases' touchpoints to mirror for 'adr'
- src/server/services/durableInteractiveTurnService.ts:1047-1063 maxview capability, 1188 check
- infra/ai-platform-v2-monitoring.tf: alerts go here

## Done
- [x] Branch created from latest main
- [x] Root-cause investigation (above)
- [x] ADR on V2 background lane (`'adr'` workflow class, worker + harvest, `adrs.generation_thread_id` migration 20261013120000, `applyAdrGenerationResult` resets + notifies on failure). Tests: adrGenerationRouting, adrReviewRoutes.
- [x] V2 flag ownership: ADR routes skip readiness pre-check when `ai-runs-v2-transport` is on; `workflowUsesMaxview` keeps maxview-mcp off ADR.
- [x] Skip only on multiple-choice (`withSkipAffordance`, guidedInterviewState tests).
- [x] V2 skill loader tries every skill root (durableInteractiveTurnService tests).
- [x] Bundled skill fallback: kickoff `skillPathIsAppDefault` (set by ADR routes when the project has no ADR skill path; stripped from client kickoffs in routes/chat.ts). V2 loader and background lane use Apex's bundled copy when the project repo lacks it. Existing ADR assistant threads lack the flag; start a new assistant chat.
- [x] ADR kickoff moved to `adrGenerationService.ts` (keeps adrService out of the V2 no-fallback guard graph).
- [x] Worker health: `interactiveActorHost/sidecarHealth.ts`; `/health` on our own express app (passed as `serverHttp`) checks Dapr metadata (placement connected, actor type hosted); degraded 60s, then 503 + `POST /v1.0/shutdown` once. NOT verified in staging yet.
- [x] Reaper retries a never-started durable turn once (`NeverStartedTurnRetry`; skips runs with a tool grant or >1 attempt).
- [x] Repo cache: eviction removes `*.tmp-<uuid>` clones older than COLD_CACHE_TIMEOUT_MS; cold clone refuses under 10 GiB free (`RepoCacheDiskFullError`, `[repo-cache] disk-low` log); `/api/health/storage` (data root writable, workspaces in /proc/mounts on App Service, free space).
- [x] App Insights: SDK default `tracesPerSecond=5` dropped most requests and their console logs (1 of 773 App Service traces had an operation id). telemetry.ts sets `tracesPerSecond: 0`. Watch ingestion volume after deploy.
- [x] Terraform `infra/alerts.tf` + variables + README + tfvars.example; prod values added to local `terraform.prd.tfvars`. fmt/validate pass; targeted plan = 31 add, 0 destroy.
- [x] CHANGELOG 1.39.1 + migration 20261013120100.
- [x] `grill-with-docs` SKILL.md line 56 matches runtime (open questions list no choices; user can reply "skip"). MaxView's copy (older, AskQuestion-based) has no skip rule, so no MV change.
- [x] Disk-full cold-clone test in repoCacheService.test.ts; retry no longer re-runs on `RepoCacheDiskFullError`.
- [x] Full suite: 3 git-heavy suites time out under full parallel load only (pass alone).

- [x] Work was pushed to main by mistake (7a4f2139); deploy cancelled before swap, main force-reset to 9afd20b6, work now on PR #212 (https://github.com/ryamiller-amergis/Apex/pull/212).
- [x] Alerts applied in prd (28 rules + action group). `cursor-prompts` container imported (it already existed). main.tf logging now matches prod portal settings (no drift).
- [x] Email hours: `alert_email_hours` → alert processing rule suppresses emails outside 08:00–18:00 Eastern daily (filter: rule ID contains `/rg-apex-prd-data/`).
- [x] Storage web test trimmed to 1 location every 15 min (~$1/month); total alert cost ~$11/month.

- [x] Bugbot: ADR watcher now starts only for in-process generation (adrGenerationService runInProcess).
- [x] Router: with V2 on, any worker-preparation/admission failure calls reportRecoverablePreparationFailure and returns `{ route: 'failed' }` (no App Service fallback). V1/flag-off unchanged.
- [x] V2 tool proxy: internal MCP fetch lacked `Accept: application/json, text/event-stream` → every internal-proxy tool call (update_adr/prd/design_doc, ADO, calendar, maxview) got 406. `postLocalMcp` in interactiveToolProxyService sends it and reads SSE replies; tested against a real SDK server.

## Next
1. After #212 merges and deploys: `terraform apply -target=azurerm_application_insights_standard_web_test.storage -target=azurerm_monitor_metric_alert.storage_availability` (prd workspace, terraform.prd.tfvars). Prod returns 401 for /api/health/storage until then.
1a. Done: `migrations/20261013120200_adr-thread-bundled-skill-flag.sql` flags existing ADR assistant/finalize threads (match on skill name; fallback only runs after the project read fails). Dry-run locally: valid, idempotent; local DB has no such threads.
2. Staging check: kill the agentic app container, confirm `/health` goes degraded → 503 and the sidecar restarts.
3. Prod Apex mirror: re-checked 2026-10-13, all 162 refs are 41 bytes (rewritten 2026-10-12 20:03 UTC), main matches GitHub, no temp clones in repo-cache. No repair needed. look at the StandupScheduler query error (App Service only, not V2; separate fix).

## Mistakes to avoid (learned in earlier chats)
- Local branch was 14 commits behind main, so read prod code from origin/main, not the old branch.
- Don't search App Insights for thread IDs to diagnose ADR; the app's request/console telemetry isn't arriving.
- The "250 GB disk" is App Service `/home`, not the Azure Files share.

## Verify with
- `npx jest src/server/__tests__/<file>.test.ts`
- `npx tsc -p tsconfig.server.json --noEmit`
- `npm run lint:check`
- `terraform fmt -recursive && terraform validate` (from infra/)

## Open questions for the user
- None yet.
