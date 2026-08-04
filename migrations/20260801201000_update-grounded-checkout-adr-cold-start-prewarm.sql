-- Third surgical update to the Grounded-Checkout ADR (8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72).
-- Adds a "Cold-start mitigation — proactive mirror pre-warm" sub-decision, updates the
-- cold-open consequence bullet to reference it, and adds scheduler/eviction references.
--
-- Depends on the second update migration (20260801200000_*, "Cross-module freshness").
-- Self-gating + atomic: skips if already applied, aborts (no changes) if item 10 is absent
-- (i.e. the previous migration has NOT been applied), and RAISEs (full rollback) if any
-- surgical replace fails to match.

DO $grounded_v4$
DECLARE
  v_adr_id UUID := '8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72';
  v_content TEXT;
  v_nl TEXT;
BEGIN
  SELECT content INTO v_content FROM adrs WHERE id = v_adr_id;
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'grounded-checkout ADR % not found', v_adr_id;
  END IF;

  IF position('11. **Cold-start mitigation' IN v_content) > 0 THEN
    RAISE NOTICE 'grounded-checkout ADR cold-start pre-warm already applied; skipping';
    RETURN;
  END IF;

  -- Gate: only proceed if the previous ("Cross-module freshness") migration is in effect.
  IF position('10. **Cross-module freshness.**' IN v_content) = 0 THEN
    RAISE EXCEPTION 'previous migration (20260801200000, item 10) not applied; aborting cold-start update with no changes';
  END IF;

  v_nl := CASE WHEN position(E'\r\n' IN v_content) > 0 THEN E'\r\n' ELSE E'\n' END;

  -- New sub-decision 11: proactive cold-start mitigation (inserted after item 10).
  v_content := replace(
    v_content,
    $q$Runs never inherit another run's pinned SHA — sharing is via the moving mirror and immutable per-SHA bundles, not a shared pinned worktree.$q$,
    $q$Runs never inherit another run's pinned SHA — sharing is via the moving mirror and immutable per-SHA bundles, not a shared pinned worktree.$q$ || v_nl ||
    $q$11. **Cold-start mitigation — proactive mirror pre-warm.** The residual cold-open cost is the shared bare-mirror cold-clone (the per-run worktree materialize stays, but is cheap on a warm mirror). Mitigate proactively: (a) **event-driven warm** — on interview/run creation, asynchronously `ensureRepoCache(repo, branch)` so the mirror is ready before the first turn; (b) a **lease-guarded periodic sweep** (every few hours, not a single morning cron) that refreshes mirrors for the active set — repos/branches with in-progress runs plus each project's default skill repo/branch (`resolveSkillConfig`) — staggered so instances do not stampede origin; (c) **idle-TTL eviction** of unused mirrors to bound `/home/data`, mirroring `devWorkspaceCleanupService`. Reuses `ensureRepoCache` + `repoCacheLeaseService` (coalescing) and the `aiCostScheduler`/`standupScheduler` interval-job pattern. A once-daily refresh is insufficient for distributed teams and repos introduced after a sweep — event-driven warm covers those.$q$
  );

  -- Consequence (cold-open): reference the pre-warm strategy.
  v_content := replace(
    v_content,
    $q$- Cold-open latency on first materialize/rehydrate (mitigated by the shared warm mirror and lease coalescing).$q$,
    $q$- Cold-open latency on first materialize/rehydrate (mitigated by the shared warm mirror, lease coalescing, and the proactive pre-warm in sub-decision 11).$q$
  );

  -- References: scheduler + eviction patterns for the pre-warm sweep.
  v_content := replace(
    v_content,
    $q$`src/server/routes/devWorkbench.ts`, `src/server/services/repoCheckoutService.ts` — the already-shipped local-checkout reference implementation.$q$,
    $q$`src/server/routes/devWorkbench.ts`, `src/server/services/repoCheckoutService.ts` — the already-shipped local-checkout reference implementation.$q$ || v_nl ||
    $q$- `src/server/services/aiCostScheduler.ts`, `src/server/services/standupScheduler.ts` — interval-scheduler pattern for the pre-warm sweep; `src/server/services/devWorkspaceCleanupService.ts` — idle-eviction pattern for bounding `/home/data`.$q$
  );

  -- Post-conditions: every intended edit must have applied, else roll back untouched.
  IF position('11. **Cold-start mitigation' IN v_content) = 0
     OR position('event-driven warm' IN v_content) = 0
     OR position('idle-TTL eviction' IN v_content) = 0
     OR position('proactive pre-warm in sub-decision 11' IN v_content) = 0
     OR position('aiCostScheduler.ts' IN v_content) = 0 THEN
    RAISE EXCEPTION 'grounded-checkout ADR cold-start update did not fully apply (a replace() failed to match); rolling back with no changes';
  END IF;

  UPDATE adrs SET content = v_content, updated_at = now() WHERE id = v_adr_id;
  RAISE NOTICE 'grounded-checkout ADR cold-start pre-warm applied successfully';
END
$grounded_v4$;
