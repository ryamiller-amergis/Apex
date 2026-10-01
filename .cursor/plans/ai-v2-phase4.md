# AI V2 runtime — Phase 4 (DEV hygiene) handoff

Branch `tbi/infra-changes`. DEV only; production V2 rollout is a separate project.
Do not delete or remove from Terraform the legacy app `ca-apex-ai-interactive-dev`
(used when `ai-runs-v2-transport` is off).

## State (2026-10-01)

- DEV runs `bc0c6bcd` on all V2 apps (working-copy size fix deploying next).
- Flags: `ai-runs-v2-transport` on for Apex and MaxView; `maxview-mcp` off globally (keep off —
  MaxView MCP is not configured in DEV and V2 turns error if it is on).
- Terraform: workspace `dev-aiv2` tracks only the V2 slice (24 resources). Always run
  `infra/scripts/dev-aiv2-tf.sh`, targeted at `terraform state list` addresses; an untargeted
  plan tries to create the base DEV stack. Last targeted plan: no changes.

## Done

- Grounding wait capped for plain chat; bundle download timeout.
- Telemetry: every V2 app reports under its own role name.
- DEV imports and hand-set settings codified.
- Harness repo prompts are project-neutral (`scripts/dev/interactive-v2-harness.mjs`).
- Idle repository checkouts are evicted when the per-replica disk budget is full
  (`groundedRepositoryCheckout.ts`). Applies to all interactive turns (Home, Interview, ADR, PRD).
- MaxView harness: plain and reconnect pass; repo turn passes or is slow depending on how much the
  agent explores (29–232 s). Accepted for now.

- Dead-letter queues cleared (155 stale messages from 2026-09-29 01:48–01:51 UTC); all DEV queues at 0.
- Replica limits already codified (1–2 per V2 app); scaling/shutdown/Dapr changes deferred to production.

## Incident: MaxView PRD generation failed (2026-10-01)

- PRD `/prd/274e36fe-dcbe-497c-bb02-4e786a66b8de`: the first PRD turn created a second MaxView
  working copy on the Agentic replica (218 MB base + 1.8 GB interview copy + 1.8 GB PRD copy > 4 Gi
  ephemeral disk). The replica was evicted, and the run ended as worker_lost.
- The App Service reaper ended the run in `agent_runs` but left its `ai_run_attempts` row
  `dispatched`. Four such rows filled the DEV interactive cap (4), so every later V2 turn waited
  until the 20-minute limit (the regenerate was retried 42 times).
- Fixes:
  - Data fix: closed the 9 leaked attempt rows.
  - `bc0c6bcd` (deployed): `finalizeAgentRun` also closes the run's V2 attempts; the
    utilization reader ignores attempts whose run already ended.
  - Working-copy size: checkout now measures the commit's real file size (`git ls-tree -l`)
    instead of using the compressed bundle size, so a copy that doesn't fit the budget falls back
    to remote reads instead of filling the disk.
- Follow-ups (not requested): App Insights keeps only about an hour of data; the orchestrator
  logs almost nothing; the DEV interactive cap is 4.

## Left in Phase 4

- Managed-identity callbacks: blocked until the user re-runs `az login` (Graph blocked by
  conditional access).
- Optional: legacy app min replicas 4 → 1 (only if asked).
- Optional: merge `main` into the branch so pull-request deploys stop failing.

## Production-rollout tasks (not DEV)

- Dapr components have two owners: `ai-runs-interactive.tf` creates `interactive-pubsub` and
  `interactive-actor-state`; `azapi_update_resource.ai_platform_v2_interactive_dapr_scopes`
  rewrites their scopes. A later legacy apply would drop the V2 apps. Fix: one definition that adds
  the V2 app IDs to scopes when split interactive is enabled; remove the azapi update.
- Worker shutdown: V2 workers abort the current job on SIGTERM; the grace period is the default
  30 s. To let jobs finish, add drain-on-SIGTERM in the worker entrypoints and set
  `termination_grace_period_seconds` (Azure max 600; agentic turns can run 20 min).
- Large repos (MaxView ~215 MB, MatterWorx ~195 MB bundles): each commit gets a full bundle;
  consider change-only bundles and blob cleanup (MaxView ~15 GB of bundles in DEV).
- Optional latency work: short repo summary up front, or tool-step cap for Home chat.
