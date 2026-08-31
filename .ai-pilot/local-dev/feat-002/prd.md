<!-- apex-grounded-sha:2e43bb1619f6c2518ddf06c84e075c94219b13eb -->

> Based on the **Apex** project, **main** branch, as of Aug 31, 2026.
---
title: Status-Driven Agent Home
slug: status-driven-agent-home
created: 2026-08-31
triage-status: needs-triage
glossary-terms-used:
  - Interview
  - PRD
  - Design Doc
  - Design Prototype
  - Backlog
  - PBI
  - TBI
  - Feature Flag
  - Open pipeline artifact
  - Artifact cycle time
  - Agent Home Dashboard
  - Agent Home Chat
  - Shared Agent Slide-out
  - Developer-to-production cycle time
  - PRD QA Suite
---

# Status-Driven Agent Home

## Problem Statement

Agent Home is chat-first: a visit to `/home` shows skill pills and a streaming conversation, not what state a project's work is in. There is no single place to see which Interviews, PRDs, QA test cases, Design Prototypes, and Design Docs are stalled, how long each takes to finish, what a developer's own Ready and In Progress load looks like, how many open Bugs sit on PBIs, or how long work takes to reach production. Getting that picture today means visiting five separate modules and assembling it by hand. Meanwhile the chat itself dominates the page even though most visits are status checks, not conversations, and the visual style of Home Chat and its sibling assistants (PRD Assistant, Design Doc Assistant, Calendar Work-Item Assistant) differs panel to panel.

## Solution

Agent Home becomes a status-driven landing page. Its main canvas is a five-tile delivery dashboard — Incomplete pipeline, Artifact cycle time, My Work, Open bugs on PBIs, and Developer-to-production cycle time — and each tile reuses the permission that already gates its underlying module, so a user only ever sees tiles they could already use elsewhere. Home Chat, PRD Assistant, Design Doc Assistant, and Calendar Work-Item Assistant share one restyled Cursor-like slide-out shell: closed by default, opened from a right-edge toggle on Home (or each assistant's existing open button), holding the composer, skill pills, MCP pills, and thread history, and rendered as a full-height overlay on narrow screens.

## Implementation Decisions

- **Pipeline Artifact Status module (deep module).** Resolves, per project, the open pipeline artifacts across Interview, PRD, Test Case (PRD QA suite), Design Prototype, and Design Doc behind one query interface. Encapsulates the stall-aware rules — a Mark-Complete Interview stays listed until a PRD exists; an owner-approved Design Prototype stays listed until a Design Doc exists; a PRD, Prototype, or Design Doc stays listed until owner final approval; a Test Case row appears only when the PRD requires a QA suite and it is not yet ready — plus the project's prototype-stage-off setting. Returns each group's count and up to 20 rows, oldest-last-updated first.
- **Artifact Cycle Time module (deep module).** Computes a 90-day median duration from creation to each artifact type's own done event (Interview Mark Complete; PRD, Prototype, and Design Doc owner final approval; Test Case suite ready), for completed items only. This is deliberately independent of the stall-aware rule above: an Interview's cycle time ends at Mark Complete even though it may still sit on the Incomplete list waiting for a PRD.
- **My Work Summary module.** Computes the signed-in user's Ready and In Progress counts and a completed-item median, branching between the Apex/Amego model (Ready = an approved Feature with no session; In Progress = an active session; done = Mark Complete) and the Azure DevOps assigned-item model (Ready-equivalent = New/Approved/Committed; In Progress = In Progress/Active; done = Done/Closed).
- **Defect Rollup module.** Resolves open child Bugs per PBI from Azure DevOps, excluding Done, Closed, Resolved, and Removed states, capped at 20 PBIs plus a project total.
- **Delivery Cycle Time module (deep module).** Joins each work item's first developer start (session start, or Azure DevOps In Progress/Active) with the production-deployment timestamp of the Release it is linked to, returning a 90-day median for linked items only. Not scoped or hidden by project name.
- **Home Dashboard Composition service.** Assembles the five tile payloads behind one interface, applies each tile's existing module permission before returning it, and isolates per-tile success, empty, and error states so one slow or failing tile never blocks the other four.
- **Shared Agent Slide-out shell (deep module, client).** The restyled panel frame, transcript, and bottom composer reused by Home Chat, PRD Assistant, Design Doc Assistant, and Calendar Work-Item Assistant. Owns the desktop side-panel versus narrow-viewport full-height-overlay layout switch, and the close-hides-but-keeps-the-thread behavior.
- **Agent Home page restructure (client).** The dashboard tiles become the main canvas. The current chat-first layout — thread history sidebar, composer, skill pills — moves into the shared slide-out shell, opened by a right-edge toggle that is hidden without `chat:view`/`chat:create`.

> The Pipeline Artifact Status module, Artifact Cycle Time module, Delivery Cycle Time module, and Shared Agent Slide-out shell are deep modules: each hides real business-rule density (stall rules, own-done-event timing, cross-system joins, and layout switching) behind a small, stable interface.

## Testing Decisions

- **What makes a good test here:** Assert each tile's visible counts, medians, and rows against the underlying business rule — for example, a Mark-Complete Interview with no PRD still appears; an owner-approved Prototype disappears once any Design Doc row exists; a Resolved Bug never counts as open — rather than asserting internal query shape. For the shared shell, verify that closing hides the panel while the reopened thread's transcript is unchanged, and that layout follows viewport width, not an internal panel flag.
- **Modules to test:**
  - Pipeline Artifact Status module — highest business-rule density (stall rules, prototype-off hiding, optional QA suite)
  - Artifact Cycle Time module — must diverge from the stall-aware Incomplete list even though both describe "done"
  - My Work Summary module — Apex/Amego versus Azure DevOps branching
  - Delivery Cycle Time module — must exclude unlinked and non-production-deployed items
  - Home Dashboard Composition service — per-tile permission hiding and error isolation
  - Shared Agent Slide-out shell — close-preserves-thread and overlay-mode switching
- **Prior art:** The existing deployment-outcome and release-metrics tests already assert median and aggregate behavior against fixture data rather than internals; the same fixture-driven aggregate pattern applies to the four new dashboard aggregation modules. Existing narrow-viewport responsive tests for other overlay panels are the template for the shared shell's overlay-mode tests.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** Home's information architecture inverts from chat-first to dashboard-first. The four affected chat surfaces gain a shared visual shell without gaining new chat product features.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Open Agent Home (`/home`) | `home:view` + `agent-home` feature flag | Project-scoped |
| View Incomplete pipeline / Artifact cycle time tiles | `home:view` + `interviews:view` with Interview menu visibility (Platform Admin excepted) | Project-scoped |
| View My Work tile | `home:view` + `dev-workbench:view` + Developer group | User-scoped (self-only) |
| View Open bugs on PBIs tile | `home:view` + `calendar:view` | Project-scoped |
| View Developer-to-production cycle time tile | `home:view` + `planning:releases` | Project-scoped |
| Open Agent Home Chat / shared slide-out on Home | `home:view` + `chat:view` + `chat:create` | Project-scoped (own thread history) |
| Open PRD Assistant / Design Doc Assistant / Calendar Work-Item Assistant | Each surface's existing permission (`prds:review`, `design-docs:review`, `calendar:view`) | Project-scoped |

---

## Security and Data Sensitivity

- **Sensitive fields:** None. Tiles show counts, statuses, titles, and created/updated/completed timestamps only.
- **Handling requirements:** None beyond the existing per-module access checks. The dashboard does not add raw Azure DevOps descriptions, reviewer emails, or chat body text.
- **Data scope enforcement:** Each tile query scopes to the caller's currently selected project. The My Work tile further scopes to the signed-in user's own items, using the same session-derived user id the My Work module already uses.

---

## Non-Functional Requirements

- **Response time:** Apex-local dashboard tiles (Incomplete pipeline, Artifact cycle time, My Work) meet a P95 of 2 seconds. Azure DevOps-backed tiles (Open bugs on PBIs, Developer-to-production cycle time) meet a P95 of 5 seconds, or show last-known values when Azure DevOps is slow.
- **Concurrency:** Supports 100 simultaneous Home loads, matching other project-scoped views.
- **Data volume:** Each list tile returns counts plus up to 20 rows; "view all" hands off to the existing module. Cycle-time tiles return aggregate medians only, never raw event dumps.

---

## Feature Flag

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** GA from launch — ships to every project that already has the `agent-home` flag enabled.
- **Kill switch owner:** Not applicable.
- **Behavior when disabled:** Not applicable. This epic adds no flag of its own; the existing `agent-home` flag keeps gating the entire `/home` route, unchanged from today.

---

## Out of Scope

- A new Home-dashboard-specific permission — every tile reuses its underlying module's existing permission.
- A Home-specific feature flag or kill switch.
- A dedicated Test Case detail route in `/backlog` (Test Case rows keep opening the parent PRD).
- An All/Mine toggle on the Incomplete pipeline tile (it stays project-wide only; "Mine" stays on Interviews & PRDs).
- Restyling Interview chat, ADR chat, Standup, or Ask Apex (they stay full-page and unaffected).
- New Cursor-only chat chrome, such as a mode picker, `@` file mentions, or checkpoints.
- Hiding the Open bugs on PBIs or Developer-to-production tiles by project name.

## Assumptions Made

- `interviews:view` and `dev-workbench:view` are wired into route guards today even though they are missing from the current RBAC governance permission-catalog document; implementation should confirm both keys exist in the live permission table.
- Interview and Test Case records have `createdAt`/`updatedAt` only, with no dedicated completion timestamp; a frozen done-event time must be captured at the moment of each status transition so later edits do not move the cycle-time number.
- Home has no existing Calendar deep-link that pre-selects a PBI; the Open bugs on PBIs tile click lands on `/calendar` generally, and the user opens the item from there.
- The Test Case group's "View all" link opens `/backlog?tab=prds` (the PRDs tab), since there is no dedicated Test Case list route.
- The Interview-tile-hide rule was not explicitly confirmed by the user in the final interview turn; this PRD applies the working rule recorded in the transcript: hide the Incomplete pipeline and Artifact cycle time tiles unless the caller can open Interview today (`interviews:view` plus Interview menu visibility, Platform Admin excepted).
- Amego already integrates with Azure DevOps, and Apex will integrate soon; neither the Open bugs on PBIs tile nor the Developer-to-production tile is hidden by project name — both stay visible on every project the caller has the matching permission for, showing an em dash when no qualifying data exists in the last 90 days.
