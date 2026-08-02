-- Update the proposed Grounded-Checkout ADR (8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72).
-- Generalizes scope from interviews/ADR threads to ALL repo-reading AI runs and
-- switches the durable grounding artifact to a content-addressed, deduped git bundle
-- keyed {provider}/{project}/{repo}/{sha} (SHA pinned in Postgres, not a per-interview blob).
--
-- Self-gating + atomic: skips if already migrated, aborts (no changes) if the content is
-- not the expected baseline, and RAISEs (full rollback) if any surgical replace fails to match.

DO $grounded_v2$
DECLARE
  v_adr_id UUID := '8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72';
  v_content TEXT;
  v_nl TEXT;
BEGIN
  SELECT content INTO v_content FROM adrs WHERE id = v_adr_id;
  IF v_content IS NULL THEN
    RAISE EXCEPTION 'grounded-checkout ADR % not found', v_adr_id;
  END IF;

  IF position('{provider}/{project}/{repo}/{sha}' IN v_content) > 0 THEN
    RAISE NOTICE 'grounded-checkout ADR already generalized; skipping';
    RETURN;
  END IF;

  IF position('{userId}/{interviewId}/mirror.bundle' IN v_content) = 0 THEN
    RAISE EXCEPTION 'grounded-checkout ADR content is not the expected baseline; aborting with no changes';
  END IF;

  v_nl := CASE WHEN position(E'\r\n' IN v_content) > 0 THEN E'\r\n' ELSE E'\n' END;

  -- Context: correct the ADO timeout claim (repo-browse ADO tools ARE wrapped now).
  v_content := replace(
    v_content,
    $q$- The ADO repo MCP tools are **not** wrapped in `raceWithTimeout`, so a stuck ADO call pins the turn until cancel/reaper.$q$,
    $q$- The ADO repo-browse MCP tools (`list_repo_dir`, `get_skill_file`, `search_repo_code`) **are** wrapped in `raceWithTimeout` today; the ADO **work-item/wiki** tools are not, so those specific calls can still pin a turn until cancel/reaper. A local checkout removes repo reads from the hot path but does not cover work-item/wiki calls.$q$
  );

  -- Context: add a paragraph establishing this is not interview-specific.
  v_content := replace(
    v_content,
    $q$meaning Blob must serve as durable backing rather than a live filesystem.$q$,
    $q$meaning Blob must serve as durable backing rather than a live filesystem.$q$ || v_nl || v_nl ||
    $q$**This is not interview-specific.** The same live-remote-MCP grounding path is used by every repo-reading AI feature — Ask Apex (`askApexService.ts`), Design Module scoping (`designModuleScopingService.ts`, which calls `search_repo_code`/`list_repo_dir`/`get_skill_file` directly), the ADR/PRD/design-doc document assistants and Agent Home chat (`buildMcpServers` in `chatAgentService.ts`), and design-doc/walkthrough generation. Worse, `searchRepoCode`'s throttle state (`activeCodeSearch`, `codeSearchBlockedUntil`) is a **module-level global**, so one feature hitting the GitHub code-search rate limit blocks *every* feature in that instance. Any fix scoped to interviews alone leaves this cross-feature bottleneck in place.$q$
  );

  -- Scope: broaden in-scope surface to all repo-grounded AI runs.
  v_content := replace(
    v_content,
    $q$In scope: a grounded local checkout for interview/ADR threads with repo MCP tools repointed to that checkout;$q$,
    $q$In scope: a grounded local checkout for **all repo-grounded AI runs** — interviews, the ADR/PRD/design-doc document assistants, Agent Home chat, Ask Apex, Design Module scoping, and design-doc/walkthrough generation (every caller of `buildMcpServers` / the `github-repo`/`ado-skills` repo tools; the calendar assistant is excluded, as it uses a restricted MCP with no repo browse) — with repo MCP tools repointed to that checkout;$q$
  );

  -- Considered option (chosen) description: generalize + content-addressed bundle.
  v_content := replace(
    v_content,
    $q$Interview/ADR threads materialize a real local git checkout;$q$,
    $q$All repo-grounded AI runs materialize a real local git checkout;$q$
  );
  v_content := replace(
    v_content,
    $q$A per-interview `git bundle` in a dedicated Blob container is the durable artifact;$q$,
    $q$A content-addressed `git bundle` (keyed `{provider}/{project}/{repo}/{sha}`, shared across runs) in a dedicated Blob container is the durable artifact;$q$
  );

  -- Sub-decision 1: shared workspace-profile MCP for all callers.
  v_content := replace(
    v_content,
    $q$1. **Repo access — workspace-profile MCP.** Add a `workspace`/`local` profile so the repo MCP tools back onto the interview's local checkout instead of `skillCatalogGitHub`/`skillCatalog`, keeping the interview prompt contract unchanged (smaller blast radius than switching interviews to built-in file tools, which is deferred).$q$,
    $q$1. **Repo access — shared workspace-profile MCP (all repo-reading callers).** Add a `workspace`/`local` profile so the repo MCP tools back onto a local checkout instead of `skillCatalogGitHub`/`skillCatalog`, keeping the prompt contract unchanged (smaller blast radius than switching to built-in file tools, which is deferred). This is a **cross-cutting grounding capability** consumed by every repo-reading caller — interviews, the ADR/PRD/design-doc assistants, Agent Home chat, Ask Apex (`askApexService.ts`), Design Module scoping (`designModuleScopingService.ts`), and design-doc/walkthrough generation — not an interview-only hook; the calendar assistant (restricted MCP) and Postgres-only write-back tools are unaffected.$q$
  );

  -- Sub-decision 2: content-addressed durable artifact; SHA pinned in Postgres.
  v_content := replace(
    v_content,
    $q$2. **Durable artifact — per-interview `git bundle`.** A single-file branch-tip snapshot; rehydrate = download → clone → `git fetch origin <branch>`.$q$,
    $q$2. **Durable artifact — content-addressed `git bundle`.** A single-file commit snapshot keyed by content, not by interview: `{provider}/{project}/{repo}/{sha}.bundle`. Bundles are **immutable/write-once** and shared (deduped) across every run and user grounded on the same SHA. The run stores only its pinned `groundedSha` (+ `groundedAt`) in Postgres — it owns a SHA, not a private copy of the repo. Rehydrate = look up `groundedSha` → download the content-addressed bundle → clone → `git checkout <sha>`.$q$
  );

  -- Sub-decision 3: hybrid runtime model wording.
  v_content := replace(
    v_content,
    $q$3. **Runtime model — hybrid.** Ephemeral per-interview working tree on local scratch; shared `ensureRepoCache` bare mirror on `/home/data` for warm cold-clone; durable bundle in Blob.$q$,
    $q$3. **Runtime model — hybrid.** Ephemeral per-run working tree on local scratch; one shared `ensureRepoCache` bare mirror per `(repo, branch)` on `/home/data` for warm cold-clone; durable content-addressed bundle per `(repo, sha)` in Blob.$q$
  );

  -- Sub-decision 4: pin at start; surface drift, don't auto-apply.
  v_content := replace(
    v_content,
    $q$4. **Refresh — signal-driven on grounded base SHA.** Persist the `baseSha`; on reopen or branch-moved signal, compare to origin tip and reset the tree + raise a "source changed — re-evaluate" flag only when it moved.$q$,
    $q$4. **Refresh — pin at start; surface drift, don't auto-apply.** Pin `groundedSha` at run start and keep the whole session on it (deterministic; no mid-session citation breakage). On reopen or a branch-moved signal, compare the pinned SHA to origin tip and, only when it moved, raise a non-blocking "source changed — re-evaluate" flag; re-grounding to the new tip happens on **explicit user action**, recording a new dated `groundedSha`. Never silently reset a live session's tree.$q$
  );

  -- Sub-decision 5: immutable snapshot; TTL backstop + fallback re-clone.
  v_content := replace(
    v_content,
    $q$5. **Lifecycle — checkpoint on idle/refresh, delete at PRD handoff.** The bundle is a warm-cache/grounding snapshot; interview content stays in `chat_messages`, so completed interviews remain openable from the DB after bundle deletion.$q$,
    $q$5. **Lifecycle — immutable snapshot, TTL backstop + fallback re-clone.** Because bundles are immutable and content-addressed, there is no checkpoint-mutation step. Deletion is a TTL backstop (~14d by last access); a needed-but-reaped SHA degrades gracefully via the existing `isCacheObjectError` → `repairRepoCache` → re-materialize path (fresh origin clone), so refcounting is optional in v1. Run content stays in `chat_messages`, so completed runs remain openable from the DB after bundle deletion.$q$
  );

  -- Sub-decision 6: per-caller flags; note the shared global singleton bottleneck.
  v_content := replace(
    v_content,
    $q$6. **Failure/rollout — feature-flagged with graceful fallback.** On materialization failure, transparently fall back to the current remote MCP; enable per project/env and revert instantly.$q$,
    $q$6. **Failure/rollout — per-caller feature flags with graceful fallback.** On materialization failure, transparently fall back to the current remote MCP; enable per caller and per project/env and revert instantly. Because `searchRepoCode`'s throttle is a module-level global, partial rollout still leaves the shared code-search bottleneck until **all** repo-reading callers are migrated — sequence the flags to converge rather than leaving a permanent split.$q$
  );

  -- Sub-decision 7: content-addressed container + RBAC deviation rationale.
  v_content := replace(
    v_content,
    $q$7. **Blob isolation — new `interview-workspaces` container.** Keyed `{userId}/{interviewId}/mirror.bundle`, added to `blob_containers` in `infra/shared-async.tf`, private, managed identity with container-scoped Blob Data Contributor, plus a lifecycle TTL (~7–14d) as a backstop to the app-level delete.$q$,
    $q$7. **Blob isolation — new `repo-grounding` container, content-addressed.** Keyed `{provider}/{project}/{repo}/{sha}.bundle`, added to `blob_containers` in `infra/shared-async.tf`, private, managed identity with container-scoped Blob Data Contributor, plus a lifecycle TTL (~14d) as a backstop. This intentionally deviates from the `{userId}/{sessionId}` path convention: RBAC stays container-scoped (posture unchanged) and grounding is **non-private repo source** (anyone who can open the run can already read that repo), so a per-user path buys no isolation while blocking the dedup that makes this scale org-wide; the deviation's isolation driver is *dedup + immutability of non-private content*. Concurrent writers of the same SHA use conditional create (`If-None-Match: *`) so a race wastes at most one upload.$q$
  );

  -- Sub-decision 8: generalize + heuristic-before-AI relevance gate.
  v_content := replace(
    v_content,
    $q$8. **Internal impact hook — SHA-diff + AI relevance gate → targeted notify.** On a branch-moved signal, find in-progress interviews behind the tip, AI-evaluate the diff against each interview's context, and notify the author via the existing notification/toast system only when relevant.$q$,
    $q$8. **Internal impact hook — SHA-diff → (heuristic, then AI) relevance gate → targeted notify.** On a branch-moved signal, find in-progress repo-grounded runs behind the tip and notify the author via the existing notification/toast system only when relevant. Start with a cheap heuristic (did the merge touch any path the run actually read or cited?) before spending tokens on an AI relevance evaluation.$q$
  );

  -- New sub-decision 9: skill-repo grounding (inserted after the rewritten item 8).
  v_content := replace(
    v_content,
    $q$before spending tokens on an AI relevance evaluation.$q$,
    $q$before spending tokens on an AI relevance evaluation.$q$ || v_nl ||
    $q$9. **Skill-repo grounding.** Grounding may span the target repo **and** a separate skill repo (skill `provider`/`branch`/`repo` can differ from the run's `repo`). Each is pinned independently under the same content-addressed scheme (`{provider}/{project}/{repo}/{sha}.bundle`).$q$
  );

  -- Consequences (positive): cross-feature coverage replaces the ADO-parity bullet.
  v_content := replace(
    v_content,
    $q$- ADO parity: stuck ADO repo calls no longer sit on the interview hot path.$q$,
    $q$- Applies to **every repo-reading AI feature** (interviews, the ADR/PRD/design-doc assistants, Agent Home chat, Ask Apex, Design Module scoping, and design-doc/walkthrough generation), not just interviews; once all callers migrate, the module-level `searchRepoCode` singleton no longer lets one feature's rate-limit stall the others.$q$
  );
  v_content := replace(
    v_content,
    $q$- Durable, multi-day grounding with per-interview isolation and clean teardown, without bloating `/home/data`.$q$,
    $q$- Durable, multi-day grounding via **content-addressed, deduped** bundles: storage scales with repo churn (roughly one bundle per repo per distinct tip), not with run/interview count, so it holds up org-wide without bloating `/home/data`.$q$
  );

  -- Consequences (negative): relevance-gate cost wording.
  v_content := replace(
    v_content,
    $q$- AI evaluation cost per impacted in-progress interview per branch move.$q$,
    $q$- Relevance-gate cost per impacted in-progress run per branch move (mitigated by the cheap heuristic pre-filter before any AI call).$q$
  );

  -- References: add the other repo-reading AI callers.
  v_content := replace(
    v_content,
    $q$- `src/server/services/repoCheckoutService.ts`, `repoCacheService.ts`, `repoWorkspaceService.ts`, `repoCacheLeaseService.ts` — cache/materialize/lease machinery.$q$,
    $q$- `src/server/services/askApexService.ts`, `src/server/services/designModuleScopingService.ts`, `src/server/services/designDocService.ts`, `src/server/services/walkthroughGenerationService.ts` — other repo-reading AI callers that must adopt the shared grounding profile.$q$ || v_nl ||
    $q$- `src/server/services/repoCheckoutService.ts`, `repoCacheService.ts`, `repoWorkspaceService.ts`, `repoCacheLeaseService.ts` — cache/materialize/lease machinery.$q$
  );

  -- Post-conditions: every intended edit must have applied, else roll back untouched.
  IF position('{provider}/{project}/{repo}/{sha}' IN v_content) = 0
     OR position('all repo-grounded AI runs' IN v_content) = 0
     OR position('9. **Skill-repo grounding.**' IN v_content) = 0
     OR position('`repo-grounding` container' IN v_content) = 0
     OR position('module-level global' IN v_content) = 0
     OR position('askApexService.ts' IN v_content) = 0 THEN
    RAISE EXCEPTION 'grounded-checkout ADR generalization did not fully apply (a replace() failed to match); rolling back with no changes';
  END IF;

  UPDATE adrs SET content = v_content, updated_at = now() WHERE id = v_adr_id;
  RAISE NOTICE 'grounded-checkout ADR generalized + content-addressed successfully';
END
$grounded_v2$;
