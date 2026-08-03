-- Seed the Phase 2 ADR: "Native Checkout Reads for Conversational and Design Agents".
-- This is a NEW, separable decision that realizes the item ADR-1
-- (grounded-checkout-interviews-blob-workspace, 8d5f9b23-…) explicitly deferred.
-- It does NOT modify ADR-1. Owner: Ryan Miller. Reviewer: Aneesh.

INSERT INTO app_users (oid, display_name, email)
VALUES (
  '110b196f-3f0d-4890-969f-5571085039de',
  'Ryan Miller',
  'ryamiller@amergis.com'
)
ON CONFLICT (oid) DO NOTHING;

INSERT INTO app_users (oid, display_name, email)
SELECT
  'c3e8f1a2-5b6d-4e7f-9a0b-1c2d3e4f5a6b',
  'Aneesh',
  'anedunur@amergis.com'
WHERE NOT EXISTS (
  SELECT 1 FROM app_users WHERE lower(email) = lower('anedunur@amergis.com')
);

DO $seed_native_reads_adr$
DECLARE
  v_owner_id TEXT := '110b196f-3f0d-4890-969f-5571085039de';
  v_thread_id UUID := '2f9c1d47-6b8a-4e3f-b1c2-7d5e9a0f4c88';
  v_adr_id UUID := '3a7e2b91-4c5d-4f6a-8b9c-1d2e3f4a5b6c';
  v_parent_adr_id UUID := '8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72';
  v_reviewer_id TEXT;
  v_skill_settings_id UUID;
  v_now TIMESTAMPTZ := '2026-08-03T01:00:00.000Z';
BEGIN
  SELECT oid INTO v_reviewer_id
  FROM app_users
  WHERE lower(email) = lower('anedunur@amergis.com')
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1;

  IF v_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'ADR reviewer Aneesh not found in app_users (expected anedunur@amergis.com)';
  END IF;

  SELECT id INTO v_skill_settings_id
  FROM project_skill_settings
  WHERE id = 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73'
  LIMIT 1;

  INSERT INTO chat_threads (
    id, user_id, status, kickoff, cursor_agent_id, workspace_dir,
    last_error, saved_wiki_url, title, flagged, flagged_at,
    active_run_id, created_at, last_activity_at
  )
  VALUES (
    v_thread_id,
    v_owner_id,
    'closed',
    jsonb_build_object(
      'repo', 'Apex',
      'model', 'claude-opus-4-8',
      'branch', 'main',
      'project', 'Apex',
      'skillPath', '/.cursor/skills/adr-interview/SKILL.md',
      'skillProvider', 'github',
      'skillSettingsId', COALESCE(v_skill_settings_id::text, 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73')
    ),
    NULL, NULL, NULL, NULL,
    'Adr Interview - Native Checkout Reads for Conversational and Design Agents',
    FALSE, NULL, NULL, v_now, v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      status = EXCLUDED.status,
      kickoff = EXCLUDED.kickoff,
      title = EXCLUDED.title,
      last_activity_at = EXCLUDED.last_activity_at;

  INSERT INTO adrs (
    id, chat_thread_id, adr_assistant_thread_id, author_id, reviewer_ids,
    title, project, repo, model, skill_settings_id, status,
    content, proposed_content, fix_comment_id, slug, created_at, updated_at
  )
  VALUES (
    v_adr_id,
    v_thread_id,
    NULL,
    v_owner_id,
    jsonb_build_array(v_reviewer_id),
    'Native Checkout Reads for Conversational and Design Agents',
    'Apex',
    'Apex',
    'claude-opus-4-8',
    v_skill_settings_id,
    'proposed',
    $native_reads_adr$
---
adr-number: ADR-pending
status: Proposed
date: 2026-08-03
slug: native-checkout-reads-conversational-agents
extends: grounded-checkout-interviews-blob-workspace
---

# Native Checkout Reads for Conversational and Design Agents

## Status

Proposed

## Context

This ADR extends **Grounded-Checkout Interviews with Blob-Backed Workspace** (`grounded-checkout-interviews-blob-workspace`), which explicitly deferred "switching interviews to built-in file tools." Phase 1 kept the repo MCP tools as the agent interface and only changed what backs them: a pinned local checkout (`LocalCheckoutReader`) when grounding resolves `mode: 'local'`, with transparent remote fallback (`RemoteCatalogReader`).

A fact surfaced after Phase 1 shipped: for a local-grounded thread the agent's working directory is ALREADY the pinned checkout. `ensureThreadGrounding` calls `adoptGroundedWorkspace`, and `runtimeWorkspaceDir()` returns that path as the `Agent.create`/`resume` cwd (`src/server/services/chatAgentService.ts`). The dev-session surface already runs this direct-checkout model. The only thing preventing native reads on the conversational/design surfaces is the system prompt, which tells the agent its cwd is "NOT a clone … use MCP."

## Decision

For interview, ADR, PRD, and design-doc agents, when grounding resolves `mode: 'local'`, instruct the agent that its working directory IS a real checkout pinned at the grounded SHA and have it read/search the repo with its native file tools instead of the MCP read tools (`get_skill_file`, `list_repo_dir`, `search_repo_code`). When grounding resolves `mode: 'remote'` (flag off or materialization failed), the current MCP-only prompt is retained verbatim. The staged-edit contract is unchanged — edits flow through `update_prd`/`update_adr`/`update_design_doc`; repo files are never written directly.

## Scope

In scope: thread the resolved `grounding.mode` (plus grounded SHA and checkout path) into the system-prompt builders (`buildFreeChatPrompt` and the assistant-type prompts) and branch the "sandbox vs. real checkout" language on it; grounding resolves before `Agent.create`, so the mode is available at build time.

Out of scope (may follow): removing the now-redundant MCP read tools on the local path; native-read telemetry parity with the FEAT-008 `LocalCheckoutReader` instrumentation; any change to dev-session or remote-fallback behavior.

## Consequences

### Positive
- Removes an unnecessary MCP round-trip on the hot path for local-grounded threads; reads become native git/grep at the pinned SHA.
- Unifies the conversational/design surfaces with the dev-session model that already reads the checkout directly.

### Negative / Risks
- Fallback correctness is mandatory: a `remote`-grounded thread must never be told to read its cwd (its cwd is only the `.ai-pilot` scratch dir). This is the primary regression risk and must be covered by tests across local, remote-fallback, dev, and each assistant type.
- Native reads bypass the FEAT-008 grounding read telemetry/access guard until parity is added (accepted gap).
- The working tree is read-only ground truth; all edits continue through the staging tools.

## References

- Parent ADR: `grounded-checkout-interviews-blob-workspace` (8d5f9b23-ac4e-5a7b-9d2f-3e6a0b4c8f72).
- `src/server/services/chatAgentService.ts` — `ensureThreadGrounding`, `adoptGroundedWorkspace`, `runtimeWorkspaceDir`, prompt builders.
- `src/server/services/groundingProfileResolver.ts`, `localCheckoutReader.ts` — grounding mode resolution and local reader.
- `src/server/routes/devWorkbench.ts`, `repoCheckoutService.ts` — the shipped direct-checkout reference implementation.
$native_reads_adr$,
    NULL,
    NULL,
    'native-checkout-reads-conversational-agents',
    v_now,
    v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET chat_thread_id = EXCLUDED.chat_thread_id,
      author_id = EXCLUDED.author_id,
      reviewer_ids = EXCLUDED.reviewer_ids,
      title = EXCLUDED.title,
      project = EXCLUDED.project,
      repo = EXCLUDED.repo,
      model = EXCLUDED.model,
      skill_settings_id = EXCLUDED.skill_settings_id,
      status = EXCLUDED.status,
      content = EXCLUDED.content,
      slug = EXCLUDED.slug,
      updated_at = EXCLUDED.updated_at;

  INSERT INTO document_approver_assignments (
    document_id, document_type, approver_user_id, assigned_by
  )
  VALUES (v_adr_id, 'adr', v_reviewer_id, v_owner_id)
  ON CONFLICT (document_id, document_type, approver_user_id) DO NOTHING;
END
$seed_native_reads_adr$;
