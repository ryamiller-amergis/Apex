# Design — Remaining Work Loop-Back to My Work

> **PRD slug:** `start-cloud-development-from-my-work` | **Priority:** Should Have | **Feature flag:** `my-work-cloud-agent`
> **Parent Epic:** Cloud Agent Run Outcomes | **Affected personas:** Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (2 unresolved)

---

## Feature Summary

**Description:** When a Cloud Agent run finishes, it can leave real work behind — checks that failed, acceptance criteria it couldn't fully satisfy, or no pull request at all. Today that context would only live inside the run's own transcript. This Feature records it as a small, structured "leftover work" summary directly on the same My Work row and the same Azure DevOps work item, so a Developer knows exactly what Resume needs to address without opening the Cloud Agent's output or hunting through the ADO work item's history. A fully clean run (PR opened, all checks passed) shows no leftover work at all — the summary is deliberately absent, not an empty "all clear" banner.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-008 | PBI | See leftover work recorded on my row after a run finishes | Should Have |
| TBI-007 | TBI | Persist and surface leftover-work summary on the run and ADO work item | Should Have |

---

## Scope and Out-of-Scope

**In scope:**
- Recording failing checks, incomplete acceptance criteria, and a missing-PR outcome as one structured summary on the session that produced a finished Cloud Agent run.
- Surfacing that summary on the same My Work row (next to the PR link) and making it available to Resume.
- Writing the same summary onto the originating Azure DevOps work item using the existing ADO write path, so the leftover work is visible without opening Apex.

**Out of scope:**
- Auto-creating child bugs, tasks, or new assigned My Work rows for leftover work (BR-007; Feature-level `outOfScope`).
- Assigning leftover work to anyone other than the session's own author (Feature-level `outOfScope`).
- Editing the Azure DevOps acceptance criteria directly from the leftover-work summary (PBI-008 `outOfScope`).
- Re-running an individual failed check from the row (Pre-PR Quality Checks Visibility Feature's `outOfScope` — leftover work only *displays* what that Feature captured, it does not add a retry action).
- A dedicated test-results viewer or reviewer-vote workflow (out of scope for the parent epic).

---

## Target Surface

**Primary surface:** Full-stack (both client and server)

**Experience notes:** Leftover work never introduces a new page, panel, or notification. It is rendered inline on the existing My Work row (the same row Start/Resume/Cancel and the PR link already live on) and, on the Azure DevOps side, as a discussion comment on the existing work item — never a new ADO item, field, or work-item type.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| View leftover-work summary on a My Work row | Developer group + `dev-workbench:view` permission | User-scoped (self-only — same session-authorship scoping as every other My Work read) |
| Have leftover work influence Resume | Developer group + `dev-workbench:view` permission | User-scoped (self-only) |

**Feature flag:** `my-work-cloud-agent` — rollout: Internal → Beta → GA
**Behavior when flag is off:** The My Work row shows none of the Cloud Agent state matrix, including leftover work; Start Local Development / Resume Session / Close Session behave exactly as they do today, unchanged.

---

## Acceptance Criteria

### PBI-008 — See leftover work recorded on my row after a run finishes

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | a run finishes with failing checks | I view the row | the failing checks are listed as leftover work alongside the PR link |
| (b) Error/failure | a run finishes with no PR at all | I view the row | "no PR yet" is recorded as leftover work |
| (c) Edge case/boundary | a run finishes fully clean (PR opened, all checks passed) | I view the row | no leftover work is shown |
| (d) Negative scenario | a session that does not belong to me | a client requests its leftover-work summary | the request is rejected |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/my-work` | `DevWorkbenchView` (ADO work-item row) | View leftover work next to the PR link on a finished Cloud Agent row | Extend existing |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `DevWorkbenchView` — leftover-work list (new inline block, same file/module as the existing ADO row) | Render failing checks, missing-PR notice, and incomplete-AC items as plain text next to the PR link | None — renders from the same session poll that already drives the row; no separate spinner | None — a fetch failure already surfaces the row's existing session error banner; the leftover-work block simply does not render | Renders nothing (not a "nothing outstanding" message) when `leftoverWork` is `null`, matching the row's existing pattern of conditionally-rendered badges (e.g. `Blocked by…`, `In PR`) |

**Validation rules:**
- Not applicable — this Feature is read-only from the client's perspective; leftover work is computed server-side when a run reaches a terminal state and is never edited from the row.

**Accessibility:**
- Leftover-work entries render as a plain-text list (`<ul>`/`<li>`), each carrying its own visible label (e.g. "Failing check: e2e — checkout flow", "No pull request was opened") — never conveyed by an icon or color alone, per PBI-008's accessibility NFR.
- The list sits inside the row's existing `aria-live` polling region so a screen-reader user is told leftover work appeared the same way other row-state changes are already announced.

**data-testid attributes:**
- `data-testid="my-work-leftover-work-{sessionId}"` — the leftover-work list container for a row.
- `data-testid="my-work-leftover-work-item-{sessionId}-{index}"` — one leftover-work entry (failing check, missing-PR notice, or incomplete-AC item).

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
