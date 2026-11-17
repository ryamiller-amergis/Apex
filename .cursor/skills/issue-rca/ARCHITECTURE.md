# Apex architecture map for RCA

Use this to decide where to look. Read the Terraform file and the code for the matching rows only. Resource names per environment are in `.cursor/skills/interactive-chat-troubleshoot/environments.json`. Production defaults: App Service `app-apex-prd` in `rg-apex-prd-app`, Postgres `psql-apex-cus` and App Insights `appi-app-apex-prd` in `rg-apex-prd-data`, database `hub`.

| Symptom | Code | Terraform | Live read |
|---------|------|-----------|-----------|
| HTTP 500, unhandled exception, blank page after an action | `src/server/routes/`, the service the route calls, `src/client/` for the screen | `infra/main.tf` (`azurerm_linux_web_app.main`, staging slot, `azurerm_application_insights.main`) | App Insights `exceptions` and `requests` where `success == false` |
| Slow page or timeout | The service and the Drizzle query it runs; `src/server/db/schema.ts` | `infra/main.tf` Postgres flexible server, `pg_stat_statements.track`, `log_min_duration_statement`; `infra/alerts.tf` postgres alert | `pg_stat_activity`, `pg_stat_statements` ordered by `total_exec_time`; App Insights request duration |
| Stuck interview, ADR, or Agent Home chat with no tokens | `src/server/services/chatAgentService.ts`, tables `chat_threads`, `agent_runs` | `infra/ai-runs-interactive.tf` (Redis, interactive Container App); `infra/ai-runs-worker.tf` (Service Bus `ai-runs-background`, runner job) | Prefer the hung-interview and interactive-chat skills. Queue depth via `servicebus queue show`. Redis and Container App via `show`. |
| Background AI run never finishes | `src/server/services/aiRunsWorker/`, `src/server/services/aiRunV2/` | `infra/ai-runs-worker.tf`; `infra/ai-platform-v2.tf`, `infra/ai-platform-v2-runtime.tf`, `infra/ai-platform-v2-identities.tf`, `infra/ai-platform-v2-monitoring.tf` | Container App and job `show`; Log Analytics on the v2 workspace; Service Bus queue `show` |
| Document / visual worker failed | `src/server/services/aiRunV2/` | `infra/ai-platform-v2-runtime.tf` (orchestrator, documents), `infra/ai-platform-v2-visual-runtime.tf` | Container App `show`; container logs in the v2 Log Analytics workspace |
| Missing or stale file, grounding checkout, avatar, playbook output | `src/server/services/grounding/bundleStoreService.ts`, `src/server/services/playbookStepOutputStore.ts`, `src/server/services/avatarStore.ts` | `infra/shared-async.tf` (one storage account, containers); `infra/repo-read-service.tf` | `storage account show`, `containerapp show` for the repo-read app. Do not download blob contents unless the issue is that file. |
| Load test did not run or results missing | `src/server/services/loadTestService.ts`, `src/server/services/loadTestRunner/` | `infra/load-test.tf` | Service Bus queue `show`, Container Apps job `show` |
| Auth, 401, 403, wrong menu | `src/server/middleware/`, `src/server/services/rbacService.ts`, `src/server/routes/auth.ts` | `infra/main.tf` App Service auth settings | App Insights traces for the route. Do not print tokens. |
| Feature flag behaves wrong | `src/server/services/featureFlagService.ts` | none | `SELECT` the flag and its assignments. Read `.cursor/skills/feature-flags/SKILL.md` before calling it a bug. |
| Notification missing | `src/server/services/notificationService.ts`, `src/server/services/aiCompletionNotifier.ts` | none | `SELECT` the notification row and the source entity status |
| Deploy works locally, fails in cloud | app settings the code reads; `src/server/utils/dataDir.ts` for ephemeral disk | the `.tf` file for that resource; `infra/alerts.tf` | `check_app_settings.py` for presence. Compare names to Terraform. Do not print values. |
| Postgres connection timeout, pool exhausted | `src/server/db.ts`, `src/server/db/drizzle.ts` | `infra/main.tf` Postgres SKU, storage, `log_min_duration_statement` | `pg_stat_activity` by `state` and `wait_event`. The client error does not name the blocking statement. |

## App Insights queries

Pass these as `--analytics-query`. Add a filter from the report (route, operation id, user id, message text). Keep `take` small.

```kusto
exceptions
| where timestamp > ago(6h)
| project timestamp, operation_Name, outerMessage, innermostMessage
| order by timestamp desc
| take 20
```

```kusto
requests
| where timestamp > ago(6h) and success == false
| project timestamp, name, resultCode, duration, url
| order by timestamp desc
| take 20
```

```kusto
traces
| where timestamp > ago(2h) and operation_Id == "<id>"
| project timestamp, severityLevel, message
| order by timestamp asc
| take 50
```

## Postgres queries

Always parameterize ids and add `LIMIT`.

```sql
SELECT state, wait_event_type, wait_event, count(*)
FROM pg_stat_activity
GROUP BY 1, 2, 3
ORDER BY count(*) DESC
LIMIT 20
```

```sql
SELECT query, calls, round(total_exec_time::numeric, 0) AS total_ms, rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10
```

`pg_stat_statements` is enabled in Terraform (`infra/main.tf`, `pg_stat_statements.track`). If the view is missing, say so; do not try to enable it.

Look up a reported id in the table that owns it (`chat_threads`, `agent_runs`, `interviews`, `feature_requests`, `adrs`) and select status and timestamp columns, not large text, unless the text is the bug.
