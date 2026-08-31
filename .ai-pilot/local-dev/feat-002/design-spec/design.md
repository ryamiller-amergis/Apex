# Design — Shared Cursor-like Slide-out Chat

> **PRD slug:** `status-driven-agent-home` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Status-Driven Agent Home | **Affected personas:** Authenticated User
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (6 unresolved)

---

## Feature Summary

**Description:** Agent Home Chat, PRD Assistant, Design Doc Assistant, and Calendar Work-Item Assistant currently ship as four separately-built panels — one full-page compose experience (Home) and three bespoke, independently-resizable side dialogs — each with its own header, resize logic, and message rendering. This Feature gives all four a single, restyled, Cursor-like slide-out shell: closed by default, opened from a right-edge toggle on Home (or each assistant's existing open action), holding the composer, skill pills, MCP pills, and thread history, and presented as a full-height overlay on narrow viewports. Closing the shell hides it without ending the underlying conversation, so any Authenticated User can check delivery status on the new Home dashboard first and pick a conversation back up exactly where they left it.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-006 | TBI | Move the Home chat composer, skill pills, and thread history into the slide-out | Must Have |
| TBI-007 | TBI | Restyle and share the slide-out shell across Home, PRD Assistant, Design Doc Assistant, and Calendar Work-Item Assistant | Must Have |
| TBI-008 | TBI | Keep the active thread alive when the slide-out is closed | Must Have |
| PBI-006 | PBI | Open and resume Agent Home Chat from a slide-out toggle | Must Have |
| PBI-007 | PBI | Experience a consistent slide-out shell across Home and existing assistants | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- Extracting Home's current compose experience (composer, skill pills, MCP pills, thread history) out of the page body and into the existing chat-panel component, so Home's main canvas is free for the FEAT-001 dashboard.
- A right-edge toggle on Home that opens/closes that panel, closed by default, hidden without `chat:view`.
- One shared visual frame (header, transcript, bottom composer) applied to Agent Home Chat, PRD Assistant, Design Doc Assistant, and Calendar Work-Item Assistant, with each assistant's own extra actions (PRD diff review, calendar confirm-before-write) still rendering inside that frame.
- A full-height overlay presentation for all four panels on narrow viewports, replacing each panel's current fixed-width, desktop-only presentation.
- Closing any of the four panels hides it and preserves the active thread; reopening resumes the same conversation. "New Chat" still starts a fresh thread.

**Out of scope:**
- Restyling Interview, ADR, Standup, or Ask Apex chat — they remain full-page, unaffected by this Feature.
- A second feature flag — this epic ships behind the existing `agent-home` flag only.
- Broader Cursor-clone chrome beyond the shared shell (mode picker, `@`-file mentions, checkpoints).
- A second floating action button on Home.
- A header chat entry point on Home — Home keeps only the right-edge toggle (no duplicate opener in the app header).
- Making Interview, ADR, or Standup chat into slide-outs.
- A dashboard-specific permission — this Feature (like Feature 1) introduces no new RBAC key.

---

## Target Surface

**Primary surface:** Frontend only (React client).

**Experience notes:** The PRD's epic-level Target Surface is "Full-stack," but that reflects Feature 1's server-side dashboard aggregation work. Every TBI/PBI under this Feature depends only on "the existing chat-panel component and its underlying chat session hook" — no new route, service, or schema. This Feature is scoped here as a client-side restyle-and-share effort layered on top of the chat surface that Feature 1's dashboard makes room for. See [design-doc-tech-spec.md](design-doc-tech-spec.md) for the full ownership rationale.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Open Agent Home Chat / shared slide-out on Home | `home:view` + `chat:view` + `chat:create` | Project-scoped (own thread history) |
| Open PRD Assistant | `prds:review` (existing) | Project-scoped |
| Open Design Doc Assistant | `design-docs:review` (existing) | Project-scoped |
| Open Calendar Work-Item Assistant | `calendar:view` (existing) | Project-scoped |

**Feature flag:** `None` — rollout: ships whenever this code deploys, gated only by the pre-existing `agent-home` flag on the `/home` route.
**Behavior when flag is off:** Not applicable — this Feature adds no flag of its own. The `agent-home` flag continues to gate the entire `/home` route exactly as it does today; when it is off, neither the dashboard nor the new right-edge toggle renders. The three non-Home assistants are unaffected by that flag.

---

## Acceptance Criteria

### PBI-006 — Open and resume Agent Home Chat from a slide-out toggle

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I have `chat:view` on Agent Home | I click the right-edge Chat toggle | The shared slide-out opens over the dashboard with the composer, skill pills, MCP pills, and thread history; closing it returns me to the dashboard |
| (b) Error/failure | The chat session fails to connect | The slide-out opens | It shows a reconnecting or error status instead of an unresponsive panel |
| (c) Edge case/boundary | I close the slide-out mid-conversation | I reopen it later | The same thread resumes instead of starting over |
| (d) Negative scenario | I do not have `chat:view` | I view Agent Home | The right-edge Chat toggle does not render |

### PBI-007 — Experience a consistent slide-out shell across Home and existing assistants

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I open Agent Home Chat, PRD Assistant, Design Doc Assistant, or Calendar Work-Item Assistant on a desktop viewport | The panel opens | All four use the same frame, transcript, and bottom composer, and each keeps its own extra actions (PRD diff review, calendar confirm-before-write) |
| (b) Error/failure | The panel fails to load its extra actions (for example diff data) | The panel is open | The shared shell still renders the transcript and composer with an inline error for the failed section |
| (c) Edge case/boundary | I open any of the four panels on a narrow viewport | The panel opens | It presents as a full-height overlay over the underlying page, and closing it returns to that page |
| (d) Negative scenario | I open the Calendar Work-Item Assistant | The panel renders | It does not show Home-only elements (skill pills, MCP pills, or thread history) |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/home` | Agent Home | Click right-edge toggle to open/close the shared slide-out over the dashboard main canvas | Extend existing (`AgentHome.tsx`, `App.tsx`) |
| `/backlog/prd/*` | PRD Review | PRD Assistant opens in the shared shell instead of its bespoke resizable panel | Extend existing (`PrdAssistantPanel.tsx`) |
| `/backlog/design-doc/*` | Design Doc Review | Design Doc Assistant opens in the shared shell | Extend existing (`DesignDocAssistantPanel` in `DesignDocReviewView.tsx`) |
| `/calendar` | Calendar | Calendar Work-Item Assistant opens in the shared shell instead of its free-floating draggable dialog | Extend existing (`CalendarWorkItemAssistantPanel.tsx`) |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `AgentSlideOutShell` (new, `agentChat/`) | Shared frame: header, resize handle, transcript embed, bottom composer, narrow-viewport overlay switch | Skeleton header/pills/thread-row/transcript-bubble placeholders (per approved prototype loading state) | Inline error region within the shell body; composer stays visible but disabled | Not applicable — delegated to each consumer's own empty-state content |
| `ChatAgentPanel` (extend) | Home + global header chat: composes `AgentSlideOutShell`, adds skill pills, MCP pills, thread history toggle | "Starting…" button state (existing) | Status bar shows "reconnecting"/"error occurred" (existing, restyled per prototype) | "No conversation yet" with quick-start shortcuts (replaces current "No active chat" state — see assumptions) |
| Home right-edge toggle (new, small button) | Opens/closes the shared shell from the dashboard main canvas | Not applicable | Not applicable | Not applicable |
| `PrdAssistantPanel` (extend) | Composes `AgentSlideOutShell`; keeps "New conversation" confirm dialog and diff-review seeding as shell extra actions | Existing "Starting assistant…" indicator | Existing inline error bubble | Existing empty-chat hint copy |
| `DesignDocAssistantPanel` (extend) | Composes `AgentSlideOutShell`; keeps validation-gap discussion seeding as shell extra actions | Existing spinner state | Existing inline error bubble | Not applicable — always seeded with a discussion opener |
| `CalendarWorkItemAssistantPanel` (extend) | Composes `AgentSlideOutShell`; keeps scope-selection step and "Review changes" banner as shell extra actions; drops free-floating drag/minimize | Existing hierarchy-loading state | Existing inline error message | Existing "ask the assistant" empty-chat hint |

**Validation rules:**
- Not applicable — this Feature has no new form fields; it restyles and relocates existing chat surfaces.

**Accessibility:**
- The right-edge toggle and slide-out panel are keyboard-operable; the panel is announced as a complementary region (`role="complementary"`, matching `ChatAgentPanel`'s existing `aria-label="Agent chat panel"`) when it opens.
- Panel title, close control, and composer remain reachable by keyboard and labeled for screen readers across all four assistants (existing pattern in `ChatAgentPanel`/`PrdAssistantPanel`/`CalendarWorkItemAssistantPanel`, extended to the shared shell).
- The slide-out opens or closes within 300ms of the toggle click, independent of chat response time (PBI-006 NFR).

**`data-testid` attributes:**
- `data-testid="home-chat-toggle-btn"` — new Home right-edge toggle button.
- `data-testid="chat-agent-close-btn"`, `data-testid="chat-agent-history-btn"`, `data-testid="chat-agent-new-chat-btn"`, `data-testid="chat-agent-composer"` — existing `ChatAgentPanel` ids, preserved unchanged through the shell refactor (see assumptions — stability is a sign-off item).
- `data-testid="prd-assistant-close-btn"`, `data-testid="prd-assistant-new-btn"`, `data-testid="calendar-assistant-close-btn"`, `data-testid="calendar-assistant-minimize-btn"` (retired if drag/minimize is dropped — see assumptions) — existing ids on the other three panels, preserved where the underlying control survives the refactor.
- New shell-level ids to add: `data-testid="agent-slideout-shell"` (root), `data-testid="agent-slideout-overlay-mode"` (present only when the narrow-viewport overlay is active, for viewport-mode assertions in tests).

---

## Link to technical specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
