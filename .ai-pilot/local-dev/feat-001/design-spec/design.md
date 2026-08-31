# Pipeline Status Dashboard — Design Doc

## 1. Feature Summary

| Field | Value |
|-------|-------|
| **Title** | Pipeline Status Dashboard |
| **PRD slug** | `status-driven-agent-home` |
| **Parent Epic** | Status-Driven Agent Home |
| **Priority** | Must Have |
| **Feature flag** | None — ships GA under the existing `agent-home` flag that already gates `/home` |
| **Affected personas** | BA, Manager, Developer, QA, Project Admin |
| **Target route** | `/home` (existing route, updated — not a new page) |

Agent Home gives BA, Manager, Developer, QA, and Project Admin a project-status view of the delivery pipeline without leaving `/home`. It replaces "open five separate modules and assemble it by hand" with a five-tile dashboard that appears as the main canvas above the existing chat composer: BA and Manager see which Interviews, PRDs, Test Cases, Design Prototypes, and Design Docs are still open and how long each artifact type takes to finish; Developer sees their own Ready/In-Progress load and completion time; QA sees which PBIs carry open Azure DevOps Bugs; Project Admin sees the project-wide median time from a developer's first start to a linked Release reaching production. Every tile reuses the permission that already gates its underlying module, so a caller only ever sees a tile for work they could already reach elsewhere in Apex.

### Work item index

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-001 | TBI | Build the Home dashboard aggregation service | Must Have |
| TBI-002 | TBI | Compute artifact cycle time medians | Must Have |
| TBI-003 | TBI | Compute developer-to-production cycle time | Must Have |
| TBI-004 | TBI | Aggregate open bugs on PBIs from Azure DevOps | Must Have |
| TBI-005 | TBI | Build dashboard tile components and client data hooks | Must Have |
| PBI-001 | PBI | View the incomplete pipeline queue | Must Have |
| PBI-002 | PBI | View artifact cycle time | Must Have |
| PBI-003 | PBI | View My Work status and cycle time | Must Have |
| PBI-004 | PBI | View open bugs on PBIs | Must Have |
| PBI-005 | PBI | View developer-to-production cycle time | Must Have |

---

## 2. Scope and Out-of-Scope

**In scope** (merged from the Feature and its PBIs/TBIs):

- Five dashboard tiles rendered as the Agent Home main canvas: Incomplete Pipeline, Artifact Cycle Time, My Work, Open Bugs on PBIs, and Developer-to-Production.
- A project-scoped, permission-gated server aggregation that composes all five tile payloads behind one interface, applying each tile's own underlying-module permission before returning that tile's data (TBI-001).
- Independent per-tile success, empty, and error states so one slow or failing tile never blocks the other four.
- Stall-aware business rules for the Incomplete Pipeline tile (BR-001 through BR-006, BR-011).
- 90-day median cycle-time computation per artifact type, independent of the stall-aware rule (BR-007, TBI-002).
- My Work Ready/In-Progress counts and completion median, branching between the Apex/Amego session model and the Azure DevOps assigned-item model (BR-008, PBI-003).
- Open child-Bug rollup per PBI from Azure DevOps, excluding Done/Closed/Resolved/Removed (BR-009, TBI-004).
- Developer-to-production median joining first developer start to a linked Release's production deployment (BR-010, TBI-003).
- Azure DevOps- and Releases-backed tiles degrading to a last-known value instead of failing the whole response when that source is slow (TBI-001).

**Out of scope:**

- An All/Mine toggle on any pipeline tile — the Incomplete Pipeline tile stays project-wide only.
- A new Test Case detail page or route — a Test Case row keeps opening its parent PRD.
- A new RBAC permission for the dashboard — every tile reuses its underlying module's existing permission; no `home-dashboard:*` key is introduced.
- Row-level lists on the Artifact Cycle Time card (PBI-002) — it stays KPI-only.
- Team-wide My Work totals (PBI-003) — the tile is self-only.
- Bugs related to a PBI by link types other than child (`related`, `duplicate`), and rollups above PBI level (PBI-004).
- A list of linked work items inside the Developer-to-Production tile (PBI-005) — it stays KPI-only.
- Hiding the Open Bugs on PBIs or Developer-to-Production tiles by project name.
- Moving the chat composer into a slide-out, restyling the chat shell, or any change to Home Chat, PRD Assistant, Design Doc Assistant, or Calendar Work-Item Assistant — that is FEAT-002 (Shared Cursor-like Slide-out Chat), which depends on this Feature but is delivered separately.

---

## 2b. Target Surface

- **Primary surface:** Full-stack (both client and server).
- **Experience notes:** Home's information architecture starts inverting from chat-first to dashboard-first with this Feature — the dashboard tiles render above the existing composer as new main-canvas content, while the composer, skill pills, History button, and thread history remain exactly where they are today. The chat surfaces themselves gain no new product features here; the visual shell restyle and slide-out relocation of chat is FEAT-002's scope.

---

## 2c. Access Control

| Tile / Action | Required group(s) / permission(s) | Data scope | Feature-flag behavior when disabled |
|---------------|-----------------------------------|-----------|--------------------------------------|
| Open Agent Home (`/home`) | `home:view` + `agent-home` feature flag | Project-scoped | Not applicable — this Feature adds no flag of its own; the existing `agent-home` flag keeps gating the whole route unchanged. |
| Incomplete Pipeline tile / Artifact Cycle Time tile | `home:view` + `interviews:view` **and** Interview menu visibility (`enabledViews.includes('backlog')`); Super Admin excepted | Project-scoped | N/A |
| My Work tile | `home:view` + `dev-workbench:view` + Developer group membership | User-scoped (signed-in user's own items only) | N/A |
| Open Bugs on PBIs tile | `home:view` + `calendar:view` | Project-scoped | N/A |
| Developer-to-Production tile | `home:view` + `planning:releases` | Project-scoped | N/A |

Every row reuses a permission that already gates the underlying module elsewhere in Apex (Interview, My Work, Calendar, Planning → Releases) — no new permission key is added for this dashboard. A tile the caller cannot access is **omitted from the server response entirely**, not hidden client-side, so no permission-gated data crosses the wire to a caller who couldn't otherwise see it.

---

## 3. Acceptance Criteria

### PBI-001 — View the incomplete pipeline queue

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Happy | I have access to Interview today and there are incomplete Interviews, PRDs, Test Cases, Prototypes, or Design Docs in the current project | I open Agent Home | The Incomplete Pipeline card lists each open group with its count and up to 20 rows sorted oldest-updated-first, plus a "View all" link per group |
| Error | the pipeline data fails to load | I open Agent Home | The Incomplete Pipeline card shows a retry-capable error state instead of a blank or crashed tile |
| Edge (empty) | the current project has no incomplete artifacts | I open Agent Home | Each pipeline group shows a short empty-state line instead of the card being hidden |
| Negative (no access) | I do not have `interviews:view` or cannot open the Interview menu today | I open Agent Home | The Incomplete Pipeline card does not render at all |

### PBI-002 — View artifact cycle time

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Happy | completed Interviews, PRDs, Test Cases, Prototypes, and Design Docs exist in the last 90 days | I open Agent Home | The Artifact Cycle Time card shows each type's median days from creation to its own done event |
| Error | the cycle-time computation fails for one artifact type | I open Agent Home | That KPI shows an error indicator while the other KPIs on the card still render normally |
| Edge (empty) | no artifact of a given type reached its done event in the last 90 days | I open Agent Home | That KPI shows an em dash and a "No completed items in the last 90 days" note |
| Negative (prototypes off) | Design Prototypes are disabled for the current project | I open Agent Home | The Prototype cycle-time KPI does not appear on the card |

### PBI-003 — View My Work status and cycle time

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Happy | I am in the Developer group with items in Ready or In Progress | I open Agent Home | The My Work tile shows my Ready and In Progress counts plus my median time to Mark Complete or Azure DevOps Done/Closed over the last 90 days |
| Error | the My Work data fails to load | I open Agent Home | The tile shows a retry-capable error state |
| Edge (empty) | I have no completed items in the last 90 days | I open Agent Home | The cycle-time number shows an em dash and the 90-day note while the counts still display |
| Negative (no access) | I cannot open My Work today (missing `dev-workbench:view` or Developer group membership) | I open Agent Home | The My Work tile does not render |

### PBI-004 — View open bugs on PBIs

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Happy | at least one PBI in the current project has an open child Bug | I open Agent Home | The Open Bugs on PBIs tile lists up to 20 PBIs sorted oldest-updated-first with their open-bug counts and a project total |
| Error | the Azure DevOps query for open Bugs fails | I open Agent Home | The tile shows a retry-capable error state instead of a stale or blank count |
| Edge (empty) | no PBI in the project has an open child Bug | I open Agent Home | The tile stays visible with empty-list copy rather than being hidden |
| Negative (no access) | I do not have `calendar:view` | I open Agent Home | The Open Bugs on PBIs tile does not render |

### PBI-005 — View developer-to-production cycle time

| Scenario | Given | When | Then |
|----------|-------|------|------|
| Happy | work items linked to a Release with a production deployment exist in the last 90 days | I open Agent Home | The tile shows the project-wide median time from developer start to that Release's production deployment, and clicking the tile opens Releases |
| Error | the Releases data fails to load | I open Agent Home | The tile shows a retry-capable error state |
| Edge (empty) | no linked work item's Release recorded a production deployment in the last 90 days | I open Agent Home | The tile shows an em dash and the 90-day note |
| Negative (no access) | I do not have `planning:releases` | I open Agent Home | The Developer-to-Production tile does not render |

---

## 4. UI/UX

### Components

A new `PipelineStatusDashboard` container renders a "Project Status" section directly below Agent Home's existing chat History button and above the page's bottom padding, matching the approved prototype exactly. It composes five tile components, laid out in two rows:

- **Row 1** (`grid-row-1`, 2fr / 1fr): **Incomplete Pipeline** card (wide, BA) + **Artifact Cycle Time** card (narrow, Manager).
- **Row 2** (`grid-row-2`, 1fr / 1fr / 1fr): **My Work** card (Developer) + **Open Bugs on PBIs** card (QA) + **Developer → Production** card (Project Admin).

### Routes and drill-through

| Element | Destination |
|---------|-------------|
| Interview pipeline row / "View all" | Existing Interview detail route / Interviews & PRDs tab |
| PRD pipeline row / "View all" | Existing PRD detail route / Interviews & PRDs tab |
| Test Case pipeline row / "View all" | Parent PRD detail route / `/backlog?tab=prds` |
| Design Prototype pipeline row / "View all" | Existing Prototype detail route / Interviews & PRDs tab |
| Design Doc pipeline row / "View all" | Existing Design Doc detail route / Interviews & PRDs tab |
| My Work tile | `/my-work` |
| Open Bugs on PBIs row / tile / "View all" | `/calendar` (general — no PBI-specific deep link exists today) |
| Developer → Production tile (whole card is clickable) | `/planning/releases` |

### States

Each tile independently renders one of four states — **loading** (skeleton matching the tile's shape), **default** (populated data), **empty** (short in-tile copy, tile still visible), **error** (icon + message + a "Retry" button) — per the approved prototype's four annotated state sections. A slow or failing tile never blocks or degrades the other four; My Work, Open Bugs, and Developer → Production render a compact icon+message+Retry block on error, while Incomplete Pipeline and Artifact Cycle Time isolate the error to the specific group/KPI that failed so the rest of the card still renders.

KPI-only tiles (Artifact Cycle Time, Developer → Production) show an em dash (`—`) plus a "No completed items in the last 90 days" caption when the 90-day window has zero qualifying items — never a bare `0`, which would be ambiguous with a genuine zero-day result.

### Validation

Not applicable — every element on this dashboard is read-only. No form, input, or mutation exists on this Feature.

### Accessibility

- Pipeline group headers, counts, and rows are screen-reader labeled (e.g., `aria-label="Interview, 3 incomplete"`) and reachable by keyboard (`tabIndex` + `Enter`/`Space`) to their destination route.
- Each KPI value and its label are exposed to screen readers as a single readable unit (e.g., a `<dl>`/`<dt>`/`<dd>` pairing or an `aria-label` combining value + unit + label), not as two disconnected text nodes.
- Counts and the My Work cycle-time value are announced with their unit ("days") to screen readers, not as a bare number.
- The Developer → Production KPI value and its "Last 90 days" scope are announced together.
- PBI rows and their bug counts on the Open Bugs on PBIs tile are keyboard-navigable to Calendar.
- Retry buttons are real `<button>` elements with a visible focus ring, not clickable `<div>`s.
- Every new interactive element carries a `data-testid` following the `home-dashboard-<tile>-<element>` convention (e.g., `home-dashboard-pipeline-card`, `home-dashboard-bugs-retry`), matching the spread-prop pattern already used elsewhere in `AgentHome.tsx`.

### `data-testid` inventory

| Element | `data-testid` |
|---------|---------------|
| Dashboard container | `home-dashboard-root` |
| Incomplete Pipeline card | `home-dashboard-pipeline-card` |
| Pipeline group (per type) | `home-dashboard-pipeline-group-{type}` |
| Artifact Cycle Time card | `home-dashboard-cycle-time-card` |
| My Work card | `home-dashboard-my-work-card` |
| Open Bugs on PBIs card | `home-dashboard-bugs-card` |
| Developer → Production card | `home-dashboard-devprod-card` |
| Per-tile retry button | `home-dashboard-{tile}-retry` |

---

## 5. Link to technical specification

See [`design-doc-tech-spec.md`](./design-doc-tech-spec.md) for the owning layer, security enforcement, architecture, data contracts, testing strategy, and implementation plan. See [`design-doc-assumptions.md`](./design-doc-assumptions.md) for unresolved items and accepted assumptions.
