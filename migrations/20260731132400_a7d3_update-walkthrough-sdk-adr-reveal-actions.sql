-- Update the "Walkthrough Runtime SDK Modularization" ADR (proposed) to fold in
-- the recommendations for items 2-4: a typed reveal-action model that supersedes
-- click-only openers, a precondition/guard model, an anchor-integrity rule, a live
-- demo-state seam (media-first retained as the fallback), and discovery-time
-- auto-derivation of reveal recipes.
--
-- Idempotent: re-running restores the same content. Targets the ADR row seeded by
-- 20260731045531_seed-production-walkthrough-sdk-modularization-adr.sql. If the seed
-- has not run in a given environment this UPDATE affects 0 rows and is a no-op.

UPDATE adrs
SET
  title = 'Walkthrough Runtime SDK Modularization: Reveal Actions, Preconditions, Demo States, and Extraction Seams',
  content = $adr$
---
adr-number: ADR-pending
status: Proposed
date: 2026-07-31
slug: walkthrough-runtime-sdk-modularization
---

# Walkthrough Runtime SDK Modularization: Reveal Actions, Preconditions, Demo States, and Extraction Seams

## Status

Proposed

## Context

The guided walkthrough runtime coaches users by navigating to a route and anchoring a coachmark to a DOM element resolved from an approved+active anchor catalog. Phase 1 shipped catalog-owned **click-openers** (`opener_anchor_keys`): at serve time enrichment resolves each opener key to a locator on the step's `WalkthroughAnchor`, and at playback `useWalkthroughAnchorTarget` clicks each opener in order (bounded wait) before resolving the target. Field testing confirmed click-openers close the modal/menu/tab gap but leave several structural limits, and a long-term goal still shapes how we should close them:

- **Click is the only reveal verb.** Openers can click a control, but many targets are gated behind *other* interactions — typing a value, selecting an option, toggling a control, focusing/expanding a panel, or waiting for an async result. Example: the Design Module "Matched files" tree only renders after a source glob is entered and a debounced preview query returns.
- **No precondition model.** Steps cannot declare the application state they require (e.g. "a repo is connected", `hasConnectedRepo`). When the precondition is unmet the coachmark silently times out to the centered fallback instead of degrading with an explanation.
- **Anchor-integrity gaps.** Some targets mount only in a data-populated branch, so the anchor `data-testid` is absent in the empty/loading state and can never resolve. Fixed for `design-module-file-tree`, but the class is otherwise unguarded.
- **Data-dependent states are depictable only via static media.** `PrdStatus`, the validation Passed/Error percentage pills, and the twelve `PrdReadinessState` values derived by `derivePrdReadiness` in `PrdReviewView` can be covered today only by attaching a screenshot/GIF; a guide overlay cannot fabricate live application state.
- **Reveal recipes are hand-authored.** Openers (and any future preconditions) must be entered per anchor in Anchor Management. This does not scale across anchors, and does not port to other teams' apps whose source we do not control.
- **Long-term vision.** We intend to roll the walkthrough capability out to other teams whose applications are not in this repository and whose source we do not control. That future requires extracting the walkthrough runtime into an injectable SDK, where anchors are resolved by resilient selectors rather than our in-repo `data-testid` catalog.

**Scope.** In scope: a typed reveal-action contract that supersedes click-only openers; a precondition/guard model with graceful degradation; an anchor-integrity authoring rule; a live demo-state seam for data-dependent panels (media-first retained as the zero-code fallback); discovery-time auto-derivation of reveal recipes; and the four extraction seams that keep a later SDK a drop-in swap. Out of scope for this ADR's first delivery: the injectable SDK package itself, a selector-capture browser extension, and a multi-tenant definition/telemetry service — all deferred but explicitly enabled.

**Constraints.** Changes must be additive and low-risk to the live walkthrough path. The anchor security model (exact catalog keys, no arbitrary selectors) must hold for in-repo playback: the action executor operates only on approved+active catalog anchors and only performs low-risk synthetic gestures (`click`, `setValue`, `select`, `toggle`, `focus`, `hover`, `scrollIntoView`, `waitFor`) — never a destructive submit. Phase 1 click-openers must migrate forward into the action model without breaking existing catalog rows. Media rendering already exists end-to-end (`WalkthroughStepContent` renders `step.imageUrl` via themed `resolveThemedImageUrl` with `imageAlt` and an `onError` fallback). The central `useWalkthroughAnchorTarget` hook is on the critical path for every anchored step, so behavior must be preserved through any refactor.

## Decision Drivers

- Let coachmarks reach elements gated behind a user action (modals, menus, tabs) without abandoning to the centered fallback.
- Express reveals **beyond click** — input, selection, toggle, focus/expand, and async waits — as declarative, catalog-owned data.
- Let steps declare **preconditions** so playback satisfies them (via the demo-state seam) or degrades with an explanatory fallback rather than a broken coachmark.
- Guarantee anchor targets **mount regardless of data state** so resolution never depends on populated content.
- Showcase data-dependent states honestly without fabricating live application state.
- **Auto-derive reveal recipes at discovery time** so coverage scales without per-anchor hand-authoring.
- Reach the long-term SDK / other-teams vision without a later big-bang rewrite of the runtime.
- Keep this iteration additive and reversible; protect the central anchor-resolution path.
- Reuse existing infrastructure: the approved+active anchor catalog, per-step media support, the serve-time enrichment pipeline, and the smart-tagging / anchor-discovery services.

## Considered Options

### Typed reveal-action model + preconditions + demo-state seam, built behind four SDK extraction seams

Generalize openers into an ordered `Action[]` union executed by a resolver-owned action executor; add a precondition/guard evaluated before resolve; add an injectable demo-state provider that feeds deterministic data to query-backed panels; extend anchor-discovery / smart-tagging to auto-propose recipes; retain media-first and the four extraction seams (Locator/AnchorResolver, NavigationAdapter, runtime module boundary, WalkthroughClient).

- Benefits: closes the reveal gap for input/async/gesture/precondition-gated targets; ships honest live states for data-dependent panels; scales via auto-derived recipes instead of hand authoring; keeps the SDK migration a swap of implementations; additive and low-risk; no PRD-module changes.
- Costs/risks: larger schema (action payloads, preconditions) and a real (if bounded) action executor; per-view demo opt-in cost; discovery heuristics to maintain and review-gate.

### Click-openers only (Phase 1 status quo)

Keep the click-only `opener_anchor_keys` mechanism and describe everything else in copy or media.

- Benefits: already shipped; smallest surface.
- Costs/risks: leaves the input/async/gesture/precondition gaps in place and keeps data-dependent states on static media only. Rejected — it does not reach the states real screens require.

### In-app demo-state framework as the primary answer

Build a generic `?demo=<variant>` provider + surface registry so any view renders deterministic variants, with PRD review as the first adopter, as the main mechanism.

- Benefits: live, deterministic states inside the real app; single source of truth via extracted presentational components.
- Costs/risks: requires per-view engineering and does not port to external apps we do not control. Rejected as the *primary* mechanism; adopted as an opt-in **seam** alongside reveal actions, with media-first as the fallback.

### Build the injectable SDK now

Extract the runtime into a distributable, selector-based SDK immediately.

- Benefits: directly serves the other-teams vision.
- Costs/risks: premature and large before the in-repo capability and seams are proven; needs a selector engine, a tenanted definition/telemetry service, and packaging with no validated consumer. Rejected — the seams capture the value incrementally.

### Do nothing — rely on the centered fallback

Keep timing out to the centered modal for gated targets and only describe states in copy.

- Benefits: no work.
- Costs/risks: leaves the primary coaching gap in place and does nothing for the SDK vision. Rejected.

## Decision Outcome

Chosen option: **Typed reveal-action model + preconditions + demo-state seam, built behind the four SDK extraction seams**, realized as:

1. **Reveal actions (supersede click-openers).** Replace the click-only `openerAnchorKeys` with an ordered, catalog-owned `Action[]` on the anchor: `click | setValue | select | toggle | focus | hover | expand | scrollIntoView | waitFor`, each referencing an approved+active catalog anchor plus a typed payload. Phase 1 openers migrate to `[{ type: 'click', … }]` with no behavior change. A resolver-owned **action executor** runs the sequence (bounded wait per step) before resolving the target, skipping actions when the target is already visible. Add a `revealing` status and `action_failed` (superseding / alongside `opener_missing`) miss reason.
2. **Preconditions / guards.** An anchor or step may declare required application state (e.g. `repoConnected`) evaluated before the action sequence. Unmet-but-resolvable preconditions are satisfied via the demo-state seam; unmet-and-unresolvable ones degrade to an explanatory fallback ("This step needs a connected repo") instead of a silent timeout.
3. **Anchor integrity.** An authoring/lint rule requires coachable targets to mount unconditionally — the anchor `data-testid` must exist in the empty/loading branch, not only when populated. Already applied to `design-module-file-tree`; generalized as a catalog-scan check so the empty-state resolution failure class stays closed.
4. **Demo-state seam (live data-dependent states).** An injectable walkthrough demo-mode provider feeds deterministic sample data to query-backed panels (Matched files, PRD status / readiness / validation %) so the UI renders the described state without real user data. Per-view opt-in; **media-first remains the zero-code fallback** where a live seam is not worth the fixture cost.
5. **Discovery-time recipe intelligence.** Extend `walkthroughAnchorSmartTaggingService` / anchor-discovery to detect conditional rendering (guarded `&&`, `.length` checks, modal/tab containment) and auto-propose the reveal `Action[]` and preconditions as catalog metadata during sync review — recipes scale without hand-authoring and remain review-gated (never auto-approved).
6. **Four extraction seams (unchanged).** (a) Model targets/actions as a `Locator` discriminated union (`testId | css | text`, only `testId` implemented) behind an `AnchorResolver` interface that also owns the action executor; `TestIdAnchorResolver` is a behavior-preserving extraction of today's `queryByTestId` + `MutationObserver` logic. (b) A `NavigationAdapter` wrapping react-router. (c) A `src/client/walkthroughRuntime/` module boundary enforced by an import rule. (d) A thin `WalkthroughClient` for definition/progress/anchor-miss calls. The demo-state provider is an additional injectable seam.
7. **Deferred but enabled.** The injectable SDK package (selector-based `AnchorResolver`, `history`-based `NavigationAdapter`, package extraction of the runtime folder, repointed `WalkthroughClient`), a selector-capture browser extension, and a tenanted definition/telemetry service remain future phases unlocked by the seams.

This best satisfies the drivers: it closes the reveal gap for input/async/gesture/precondition-gated targets and delivers honest live-state coverage now, while converting the SDK / other-teams goal from a rewrite into additive swaps, all behind a behavior-preserving refactor of the central path.

## Consequences

### Positive

- Coachmarks reach targets gated by input, selection, toggle, focus/expand, async, or precondition — not just modal/menu/tab clicks — using approved catalog anchors only (no arbitrary selectors), consistent with the existing security model.
- Data-dependent states can be shown live and deterministically via the demo-state seam; media-first stays available with zero new code.
- Auto-derived recipes cut per-anchor authoring and extend coverage as the app grows.
- The anchor-integrity rule eliminates the empty-state resolution failure class.
- The change is additive: click-openers migrate forward into the action model, the SDK path stays a swap, and it touches no PRD code and no restricted config.

### Negative

- A larger schema (action payloads, preconditions) and a real action executor increase surface area and the behavior-drift risk on the central `useWalkthroughAnchorTarget` path (mitigated by landing the resolver / nav-adapter extraction as a test-covered, behavior-preserving change first, then the action model, then preconditions).
- The demo-state seam carries per-view fixture / opt-in cost and must be re-checked when the UI changes; media-depicted states remain static screenshots/GIFs/video that must be re-captured.
- Discovery heuristics can mis-propose recipes; they are review-gated in sync and never auto-approved.
- Synthetic gestures broaden the interaction surface; they are constrained to non-destructive verbs on approved anchors, with no auto-submit, and openers do not auto-close on step change.

### Unresolved / follow-up

- External / selector-based anchor resolution, the tenanted definition/telemetry service, media asset upload UX (vs URL-only today), and demo-fixture governance remain to be designed in follow-up ADRs.

## References

- `src/client/hooks/useWalkthroughAnchorTarget.ts` — navigate + `queryByTestId` + `MutationObserver` + `ANCHOR_WAIT_MS`; target of the resolver / nav-adapter seams and the action-executor generalization.
- `src/client/components/WalkthroughRenderer.tsx` — coachmark-vs-modal selection, `locating` / `revealing` / fallback wiring.
- `src/client/components/WalkthroughStepContent.tsx` — existing `step.imageUrl` rendering (themed, alt, onError) for media-first states.
- `src/client/components/DesignModuleFileTree.tsx` — anchor-integrity example (anchor `data-testid` mounted in the empty state).
- `src/shared/walkthroughAssets.ts` — `resolveThemedImageUrl`.
- `src/shared/types/walkthrough.ts` — `WalkthroughAnchor`, `WalkthroughAnchorMissReason` (adds `revealing` / `action_failed`); target of the `Action[]` and precondition types.
- `src/shared/types/walkthroughAnchorRegistry.ts` — anchor record / command types (openers migrate into the reveal-action + precondition model).
- `src/server/db/schema.ts` — `walkthroughAnchorRegistry` (`opener_anchor_keys` generalized to reveal actions / preconditions).
- `src/server/services/walkthroughAnchorRegistryService.ts`, `src/server/services/walkthroughService.ts`, `src/server/services/walkthroughAnchorCatalogResolution.ts` — persistence, validation, and serve-time enrichment for actions/preconditions.
- `src/server/services/walkthroughAnchorSmartTaggingService.ts`, `.cursor/skills/walkthrough-anchor-discovery/SKILL.md`, `.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md` — discovery-time recipe derivation.
- `src/client/components/WalkthroughAnchorManagement.tsx` — authoring UI for reveal actions and preconditions.
- `src/shared/utils/prdReadiness.ts`, `src/client/components/PrdReviewView.tsx` — data-dependent states motivating the demo-state seam and media-first fallback.
- `.cursor/plans/walkthrough_auto-open_and_demo_states_0e29e155.plan.md` — Phase 1 (click-openers) implementation plan that this decision supersedes and extends.
$adr$,
  updated_at = NOW()
WHERE id = 'a2e5d3c8-9f04-4b26-8d7c-3a6b4e9f1d05';
