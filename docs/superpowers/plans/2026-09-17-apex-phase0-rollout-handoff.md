# Apex AI Reliability Phase 0 — PR and Rollout Handoff

**Branch:** `tbi/infra-changes`  
**Status:** Local implementation and verification complete; not pushed or deployed.

## PR recommendation

**Title:** Phase 0: stabilize AI workload watchers and recovery

**Summary:**

- Reconcile Terraform ownership with the active Central US PostgreSQL server.
- Make Design Doc watchers single-owner, lease-fenced, non-overlapping, and
  resilient to database errors.
- Leader-elect recovery and reaper work, and bound startup recovery categories.
- Keep the approved complete V1 reaper scan leader-only until V2 introduces an
  indexed `next_action_at`.
- Refresh Service Bus credentials and requests safely after authorization
  failures.
- Persist the 10-minute worker-heartbeat mitigation as a sticky slot setting.
- Separate liveness, readiness, and dependency health.
- Add control-plane indexes and safe database-pool telemetry.

## Reviewer entry points

Review in this order:

1. `src/server/services/repoCacheLeaseService.ts`
2. `src/server/services/designDocService.ts`
3. `src/server/services/agentRunReaperService.ts`
4. `src/server/services/startupRecovery.ts`
5. `src/server/services/serviceBusPublisher.ts`
6. `migrations/20260917170000_agent-run-control-plane-indexes.js`
7. `src/server/routes/api.ts`, `src/server/db.ts`, and
   `src/server/services/dbPoolTelemetry.ts`
8. `.github/workflows/deploy.yml` and `infra/main.tf`
9. Corresponding test files

## Local verification evidence

- Focused merged regression run: 11 suites, 353 tests passed, 0 failed.
- Server TypeScript build: passed.
- Terraform formatting: passed.
- Terraform configuration validation: passed.
- Final whole-branch review: approved with no Critical or Important findings
  after remediation.
- Latest verified production Terraform plan before the comment-only final
  Terraform edit: no changes.
- No migration, deployment, Terraform apply, push, or database deletion was
  performed from this branch.

## Migration note

The control-plane index migration is the repository's first
`pgm.noTransaction()` migration. It builds and drops indexes concurrently so
the hot `agent_runs` table can continue accepting writes.

Immediately after migrations, verify that none of the three indexes is invalid:

```sql
SELECT indexrelid::regclass AS index_name
FROM pg_index
WHERE indexrelid::regclass::text IN (
  'idx_agent_runs_thread_created',
  'idx_agent_runs_thread_active',
  'idx_design_docs_transient_updated'
)
AND NOT indisvalid;
```

Expected result: zero rows. If any row appears, stop rollout. Drop only the
reported invalid index with `DROP INDEX CONCURRENTLY`, recreate it with the DDL
from the migration, and repeat the check before continuing.

## Rollout sequence

1. Push the branch and open the PR only after explicit user approval.
2. Require PR tests, server build, and migration review to pass.
3. Deploy to the staging slot without increasing worker or App Service capacity.
4. Confirm the database-hostname guard targets `psql-apex-cus`.
5. Run the invalid-index query above.
6. Verify:
   - `/api/health` and `/api/health/live` report process liveness;
   - `/api/health/ready` reports database readiness;
   - `/api/health/dependencies` reports external dependency health;
   - `/api/health/agents` includes numeric database-pool aggregates.
7. Confirm staging has
   `AI_RUN_WORKER_HEARTBEAT_TIMEOUT_MS=600000` as a slot setting.
8. Run staging smoke tests and one controlled Design Doc generation.
9. Swap staging to production.
10. Confirm both slots still have the 600,000 ms heartbeat value.
11. Run production-safe smoke tests.
12. Run the 25-document regression in an approved test project before any
    capacity increase.
13. Observe the system before proceeding to Task 3 rollout work.

## 25-document acceptance gate

Pass only when:

- each document has one logical watcher owner;
- no duplicate terminal result or duplicate completion notification occurs;
- no run is incorrectly marked `worker_lost`;
- no App Service restart, container crash, or sustained HTTP 5xx spike occurs;
- database-pool waiting remains bounded and pressure telemetry is investigated;
- control-plane QPS is no greater than 5;
- incremental batch QPS is no greater than 10 over baseline;
- every infrastructure failure reaches a clear terminal state or safe retry;
- PostgreSQL CPU, latency, active connections, and pool measurements stay
  within the approved rollout gates.

Record upstream AI/model failures separately from infrastructure failures.

## Rollback

Rollback immediately if health, index validity, duplicate-work, connection, or
error-rate gates fail:

1. Swap back to the previously healthy slot.
2. Stop new bulk generation admissions while existing work settles.
3. Confirm `/api/health/ready` and database-pool telemetry recover.
4. Restore the previously deployed application package if swap-back is
   insufficient.
5. Keep the 600,000 ms heartbeat mitigation during rollback.
6. Do not remove the additive indexes unless query evidence shows a regression.
   If removal is required, use the migration's concurrent drop statements.
7. Preserve logs, run IDs, thread IDs, lease generations, and database metrics
   for diagnosis.

## Explicitly outside this branch

- Deletion of the stopped East US 2 PostgreSQL server.
- V2 `next_action_at` reaper indexing and durable run protocol.
- New Service Bus lanes, Container Apps, Redis replacement, or capacity
  expansion.
- Legacy-resource retirement.

Those changes require their own approved task, branch, tests, and rollback gate.
