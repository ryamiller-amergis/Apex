-- Second surgical update to the Grounded-Checkout ADR (8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72).
-- Adds: grounding-unit clarification (one checkout per repo+SHA; modules are glob views),
-- audited exemptions (walkthroughAiDraftService) + reference implementation (devWorkbench),
-- a new "Cross-module freshness" sub-decision, and expanded references.
--
-- Depends on the first update migration (20260801190000_*). Self-gating + atomic:
-- skips if already applied, aborts (no changes) if the expected post-v2 baseline is absent,
-- and RAISEs (full rollback) if any surgical replace fails to match.

DO $grounded_v3$
DECLARE
  v_adr_id UUID := '8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72';
  v_content TEXT;
  v_nl TEXT;
BEGIN
  SELECT content INTO v_content FROM adrs WHERE id = v_adr_id;
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'grounded-checkout ADR % not found', v_adr_id;
  END IF;

  IF position('10. **Cross-module freshness.**' IN v_content) > 0 THEN
    RAISE NOTICE 'grounded-checkout ADR cross-module freshness already applied; skipping';
    RETURN;
  END IF;

  IF position('9. **Skill-repo grounding.**' IN v_content) = 0 THEN
    RAISE EXCEPTION 'expected post-v2 ADR baseline not found (run 20260801190000 first); aborting with no changes';
  END IF;

  v_nl := CASE WHEN position(E'\r\n' IN v_content) > 0 THEN E'\r\n' ELSE E'\n' END;

  -- Runtime model (item 3): clarify the grounding unit and modules-as-views.
  v_content := replace(
    v_content,
    $q$durable content-addressed bundle per `(repo, sha)` in Blob.$q$,
    $q$durable content-addressed bundle per `(repo, sha)` in Blob. The grounding unit is one checkout per `(provider, project, repo, sha)`, shared across consumers; Design Modules are `sourceGlobs` views over the project's connected repo (never a checkout per module), and a project's multiple repos — one per skill-settings config (`resolveSkillConfig`) plus any per-interview target repo — each key independently.$q$
  );

  -- Context ("not interview-specific" paragraph): record audited exemptions + reference impl.
  v_content := replace(
    v_content,
    $q$Any fix scoped to interviews alone leaves this cross-feature bottleneck in place.$q$,
    $q$Any fix scoped to interviews alone leaves this cross-feature bottleneck in place. (Audited exemptions: `walkthroughAiDraftService` uses the Cursor SDK with no repo MCP or checkout and is out of scope; `devWorkbench` / `repoCheckoutService` already materializes a full local clone and is the reference implementation for this decision.)$q$
  );

  -- New sub-decision 10: cross-module freshness (inserted after item 9).
  v_content := replace(
    v_content,
    $q$Each is pinned independently under the same content-addressed scheme (`{provider}/{project}/{repo}/{sha}.bundle`).$q$,
    $q$Each is pinned independently under the same content-addressed scheme (`{provider}/{project}/{repo}/{sha}.bundle`).$q$ || v_nl ||
    $q$10. **Cross-module freshness.** Freshness is a per-consumer policy, not global. Short-lived one-shot runs (Design Module scoping, Ask Apex, walkthrough generation) pin to the current tip at start and are naturally fresh; long-lived interactive runs (interviews) pin at start, drift-detect, and honor a **staleness budget** (force a re-ground checkpoint once past N days / M commits behind). A pipeline instance (interview → PRD → design-doc) **propagates one grounded SHA** so downstream artifacts match the world their upstream was written against; re-grounding at a phase boundary re-pins subsequent phases and flags the drift. Because bundles are content-addressed and the shared mirror never GCs, both the old and new SHAs stay materializable across the transition. Runs never inherit another run's pinned SHA — sharing is via the moving mirror and immutable per-SHA bundles, not a shared pinned worktree.$q$
  );

  -- References: project→repo resolution + exemptions.
  v_content := replace(
    v_content,
    $q$- `src/server/services/askApexService.ts`, `src/server/services/designModuleScopingService.ts`, `src/server/services/designDocService.ts`, `src/server/services/walkthroughGenerationService.ts` — other repo-reading AI callers that must adopt the shared grounding profile.$q$,
    $q$- `src/server/services/askApexService.ts`, `src/server/services/designModuleScopingService.ts`, `src/server/services/designDocService.ts`, `src/server/services/walkthroughGenerationService.ts` — other repo-reading AI callers that must adopt the shared grounding profile.$q$ || v_nl ||
    $q$- `src/server/services/projectSettingsService.ts` (`resolveSkillConfig` / `listSkillConfigsForProject`), `src/shared/types/designModule.ts` — a project resolves one connected repo per skill-settings config; Design Modules carry only `sourceGlobs` (no per-module repo). `src/server/services/walkthroughAiDraftService.ts` — exempt (no repo access). `src/server/routes/devWorkbench.ts`, `src/server/services/repoCheckoutService.ts` — the already-shipped local-checkout reference implementation.$q$
  );

  -- Post-conditions: every intended edit must have applied, else roll back untouched.
  IF position('10. **Cross-module freshness.**' IN v_content) = 0
     OR position('The grounding unit is one checkout per' IN v_content) = 0
     OR position('Audited exemptions:' IN v_content) = 0
     OR position('resolveSkillConfig' IN v_content) = 0 THEN
    RAISE EXCEPTION 'grounded-checkout ADR cross-module update did not fully apply (a replace() failed to match); rolling back with no changes';
  END IF;

  UPDATE adrs SET content = v_content, updated_at = now() WHERE id = v_adr_id;
  RAISE NOTICE 'grounded-checkout ADR cross-module freshness applied successfully';
END
$grounded_v3$;
