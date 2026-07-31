-- Seed the proposed Walkthrough Runtime SDK Modularization ADR for production.
-- Owner: Ryan Miller (ryamiller@amergis.com). Reviewer: Aneesh (anedunur@amergis.com).
-- Model: claude-opus-4-8. Thread runtime fields are sanitized (no local agent/workspace identifiers).

INSERT INTO app_users (oid, display_name, email)
VALUES (
  '110b196f-3f0d-4890-969f-5571085039de',
  'Ryan Miller',
  'ryamiller@amergis.com'
)
ON CONFLICT (oid) DO NOTHING;

-- Ensure Aneesh is findable by email (local DBs may lack the production AAD row).
INSERT INTO app_users (oid, display_name, email)
SELECT
  'c3e8f1a2-5b6d-4e7f-9a0b-1c2d3e4f5a6b',
  'Aneesh',
  'anedunur@amergis.com'
WHERE NOT EXISTS (
  SELECT 1 FROM app_users WHERE lower(email) = lower('anedunur@amergis.com')
);

DO $seed_walkthrough_sdk_adr$
DECLARE
  v_owner_id TEXT := '110b196f-3f0d-4890-969f-5571085039de';
  v_thread_id UUID := 'b1f4c2d7-8e93-4a15-9c6b-2f7a3d5e8c04';
  v_adr_id UUID := 'a2e5d3c8-9f04-4b26-8d7c-3a6b4e9f1d05';
  v_reviewer_id TEXT;
  v_skill_settings_id UUID;
  v_now TIMESTAMPTZ := '2026-07-31T04:55:31.000Z';
BEGIN
  SELECT oid
  INTO v_reviewer_id
  FROM app_users
  WHERE lower(email) = lower('anedunur@amergis.com')
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1;

  IF v_reviewer_id IS NULL THEN
    RAISE EXCEPTION 'ADR reviewer Aneesh not found in app_users (expected anedunur@amergis.com)';
  END IF;

  SELECT id
  INTO v_skill_settings_id
  FROM project_skill_settings
  WHERE id = 'df2ab8a5-3a3e-4cbe-b685-1a3e6f0e6d73'
  LIMIT 1;

  INSERT INTO chat_threads (
    id,
    user_id,
    status,
    kickoff,
    cursor_agent_id,
    workspace_dir,
    last_error,
    saved_wiki_url,
    title,
    flagged,
    flagged_at,
    active_run_id,
    created_at,
    last_activity_at
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
    NULL,
    NULL,
    NULL,
    NULL,
    'Adr Interview - Walkthrough Runtime SDK Modularization',
    FALSE,
    NULL,
    NULL,
    v_now,
    v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET
    user_id = EXCLUDED.user_id,
    status = EXCLUDED.status,
    kickoff = EXCLUDED.kickoff,
    title = EXCLUDED.title,
    last_activity_at = EXCLUDED.last_activity_at;

  INSERT INTO adrs (
    id,
    chat_thread_id,
    adr_assistant_thread_id,
    author_id,
    reviewer_ids,
    title,
    project,
    repo,
    model,
    skill_settings_id,
    status,
    content,
    proposed_content,
    fix_comment_id,
    slug,
    created_at,
    updated_at
  )
  VALUES (
    v_adr_id,
    v_thread_id,
    NULL,
    v_owner_id,
    jsonb_build_array(v_reviewer_id),
    'Walkthrough Runtime SDK Modularization: Auto-Open, Media States, and Extraction Seams',
    'Apex',
    'Apex',
    'claude-opus-4-8',
    v_skill_settings_id,
    'proposed',
    $production_adr$
---
adr-number: ADR-pending
status: Proposed
date: 2026-07-31
slug: walkthrough-runtime-sdk-modularization
---

# Walkthrough Runtime SDK Modularization: Auto-Open, Media States, and Extraction Seams

## Status

Proposed

## Context

The guided walkthrough runtime coaches users by navigating to a route and anchoring a coachmark to a DOM element resolved from an approved+active anchor catalog. Two gaps limit its reach today, and a third strategic goal shapes how we should close them:

- **Modal / hidden targets.** `useWalkthroughAnchorTarget` only calls `navigate()` and then waits `ANCHOR_WAIT_MS` (2.5s) for a `[data-testid]` via `queryByTestId` + `MutationObserver`; if the target lives inside a closed modal, dropdown, collapsed panel, or unselected tab it never appears, so the step times out and falls back to a centered modal ("We couldn't find that spot in the UI"). There is no mechanism to place the app into the required UI state.
- **Data-dependent states.** Many views render variants that depend on real data — e.g. `PrdStatus`, the validation Passed/Error percentage pills, and the twelve `PrdReadinessState` values derived by `derivePrdReadiness` in `PrdReviewView`. A guide overlay cannot fabricate application state; like Pendo/Appcues/WalkMe it can only point at whatever the live DOM shows.
- **Long-term vision.** We intend to roll the walkthrough capability out to other teams whose applications are not in this repository and whose source we do not control. That future requires extracting the walkthrough runtime into an injectable SDK, where anchors are resolved by resilient selectors rather than our in-repo `data-testid` catalog.

**Scope.** In scope: an auto-open (reveal) capability for anchored steps; using existing per-step media to depict data-dependent states; and refactoring the runtime behind extraction seams so a later SDK is a drop-in swap. Out of scope for this ADR's first delivery: the in-app demo-state framework, the injectable SDK package itself, a selector-capture browser extension, and a multi-tenant definition/telemetry service — all deferred but explicitly enabled.

**Constraints.** Changes must be additive and low-risk to the live walkthrough path. The anchor security model (exact catalog keys, no arbitrary selectors) must hold for in-repo playback. Media rendering already exists end-to-end: `WalkthroughStepContent` renders `step.imageUrl` via themed `resolveThemedImageUrl` with `imageAlt` and an `onError` fallback, and the authoring editors already expose it. The central `useWalkthroughAnchorTarget` hook is on the critical path for every anchored step, so behavior must be preserved through any refactor.

## Decision Drivers

- Let coachmarks reach elements gated behind a user action (modals, menus, tabs) without abandoning to the centered fallback.
- Showcase data-dependent states honestly without fabricating live application state.
- Reach the long-term SDK / other-teams vision without a later big-bang rewrite of the runtime.
- Keep this iteration additive and reversible; protect the central anchor-resolution path.
- Reuse existing infrastructure: the approved+active anchor catalog, per-step media support, and the serve-time enrichment pipeline.

## Considered Options

### Auto-open + media-first, built behind four SDK extraction seams

Add catalog-owned "opener" anchors that playback clicks (waiting for each) before resolving the target; use existing image/GIF (optionally short video) media steps to depict data-dependent states; and introduce four seams — a Locator/AnchorResolver abstraction, a NavigationAdapter, a runtime module boundary, and a WalkthroughClient transport — so the runtime can later be extracted into an injectable SDK.

- Benefits: solves the modal/hidden-target gap for in-repo apps now; ships data-dependent-state coverage with near-zero new code (media already wired); makes the SDK migration a swap of implementations rather than a rewrite; additive and low-risk; no PRD-module changes.
- Costs/risks: modest upfront refactor of the central hook behind interfaces; openers add a small DB column, type fields, and authoring UI; media states are static rather than live.

### In-app demo-state framework now

Build a generic `?demo=<variant>` provider + surface registry so any view renders deterministic variants, with PRD review as the first adopter.

- Benefits: live, deterministic states inside the real app; single source of truth via extracted presentational components.
- Costs/risks: requires per-view engineering (extracting PRD pills, fixtures) and does not port to external apps we do not control; larger surface area and PRD-module coupling now. Rejected for this iteration; revisited after the seams land.

### Build the injectable SDK now

Extract the runtime into a distributable, selector-based SDK immediately.

- Benefits: directly serves the other-teams vision.
- Costs/risks: premature and large before the in-repo capability and seams are proven; needs a selector engine, a tenanted definition/telemetry service, and packaging with no validated consumer. Rejected — the seams capture the value incrementally.

### Do nothing — rely on the centered fallback

Keep timing out to the centered modal for hidden targets and only describe states in copy.

- Benefits: no work.
- Costs/risks: leaves the primary coaching gap in place and does nothing for the SDK vision. Rejected.

## Decision Outcome

Chosen option: **Auto-open + media-first, built behind four SDK extraction seams**, realized as:

1. **Auto-open (reveal actions).** Anchor catalog rows gain an ordered `openerAnchorKeys` list (a new `opener_anchor_keys` JSONB column). At serve time, enrichment resolves each opener key to a locator on the step's `WalkthroughAnchor`; at playback the runtime clicks each opener in order (bounded wait) before resolving the target, skipping openers when the target is already visible. A new `revealing` status and `opener_missing` miss reason are added. Openers are catalog-owned so every walkthrough using the anchor inherits the behavior.
2. **Media-first for data-dependent states.** Reuse the existing per-step image/GIF rendering to depict states (PRD status, readiness, validation %); optionally add a `<video>` branch for short recordings. No demo framework and no PRD-module changes in this iteration.
3. **Four extraction seams.** (a) Model targets/openers as a `Locator` discriminated union (`testId | css | text`, only `testId` implemented) behind an `AnchorResolver` interface, with `TestIdAnchorResolver` a behavior-preserving extraction of today's `queryByTestId` + `MutationObserver` logic. (b) A `NavigationAdapter` wrapping react-router. (c) A `src/client/walkthroughRuntime/` module boundary enforced by an import rule. (d) A thin `WalkthroughClient` for definition/progress/anchor-miss calls.
4. **Deferred but enabled.** The in-app demo-state framework and the injectable SDK (selector-based `AnchorResolver`, `history`-based `NavigationAdapter`, package extraction of the runtime folder, and a repointed `WalkthroughClient`) are explicitly future phases unlocked by the seams.

This best satisfies the drivers: it closes the modal gap and delivers state coverage now while converting the SDK / other-teams goal from a rewrite into additive swaps, all behind a behavior-preserving refactor of the central path.

## Consequences

### Positive

- Coachmarks reach modal/menu/tab-gated elements via catalog-owned openers, using approved catalog testids only (no arbitrary selectors) — consistent with the existing security model.
- Data-dependent states are covered immediately with existing media support; optional video is additive.
- The four seams make the eventual SDK a swap of `AnchorResolver` / `NavigationAdapter` / `WalkthroughClient` implementations plus a folder extraction — no runtime rewrite.
- The change is additive (defaulted DB column, optional type fields, additive media branch) and touches no PRD code and no restricted config.

### Negative

- A modest refactor of the central `useWalkthroughAnchorTarget` hook is required; behavior drift there would regress existing coachmarks (mitigated by landing the resolver / nav-adapter extraction as a test-covered, behavior-preserving change before adding opener logic).
- Media-depicted states are static screenshots/GIFs/video and must be re-captured when the UI changes; live deterministic states wait on the deferred demo framework.
- Openers introduce a small maintenance surface (catalog column, authoring UI, cycle/self/approved-active validation) and do not auto-close on step change.
- Unresolved risks: external / selector-based anchor resolution, the demo-state framework's per-view fixture cost, media asset upload UX (vs URL-only today), and the tenanted definition/telemetry service remain to be designed in follow-up ADRs.

## References

- `src/client/hooks/useWalkthroughAnchorTarget.ts` — navigate + `queryByTestId` + `MutationObserver` + `ANCHOR_WAIT_MS`; target of the resolver / nav-adapter seams and the opener sequence.
- `src/client/components/WalkthroughRenderer.tsx` — coachmark-vs-modal selection, `locating` / fallback wiring.
- `src/client/components/WalkthroughStepContent.tsx` — existing `step.imageUrl` rendering (themed, alt, onError) for media states.
- `src/shared/walkthroughAssets.ts` — `resolveThemedImageUrl`.
- `src/shared/types/walkthrough.ts` — `WalkthroughAnchor`, `WalkthroughAnchorMissReason` (adds `opener_missing`).
- `src/shared/types/walkthroughAnchorRegistry.ts` — anchor record / command types (adds `openerAnchorKeys`).
- `src/server/db/schema.ts` — `walkthroughAnchorRegistry` (adds `opener_anchor_keys`).
- `src/server/services/walkthroughAnchorRegistryService.ts`, `src/server/services/walkthroughService.ts`, `src/server/services/walkthroughAnchorCatalogResolution.ts` — persistence, validation, and serve-time enrichment for openers.
- `src/client/components/WalkthroughAnchorManagement.tsx` — authoring UI for opener anchor keys.
- `src/shared/utils/prdReadiness.ts`, `src/client/components/PrdReviewView.tsx` — data-dependent states motivating media-first coverage.
- `.cursor/plans/walkthrough_auto-open_and_demo_states_0e29e155.plan.md` — the implementation plan for this decision.
$production_adr$,
    NULL,
    NULL,
    'walkthrough-runtime-sdk-modularization',
    v_now,
    v_now
  )
  ON CONFLICT (id) DO UPDATE
  SET
    chat_thread_id = EXCLUDED.chat_thread_id,
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
    document_id,
    document_type,
    approver_user_id,
    assigned_by
  )
  VALUES (
    v_adr_id,
    'adr',
    v_reviewer_id,
    v_owner_id
  )
  ON CONFLICT (document_id, document_type, approver_user_id) DO NOTHING;
END
$seed_walkthrough_sdk_adr$;
