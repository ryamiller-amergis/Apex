# Design — Admin Per-Module Effort Defaults

> **PRD slug:** `per-module-agent-effort-defaults` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Per-Module Agent Effort Defaults | **Affected personas:** Project Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (2 unresolved)

---

## Feature Summary

**Description:** Project Admins can already choose an AI model per Cursor-backed agent module (Interview, PRD, ADR, Design Doc, and the rest) in Admin → Project Settings, but there is no matching control for reasoning effort — every module always runs at whatever effort the Cursor SDK defaults to. This feature adds one sibling effort selector next to each existing model override, with an explicit "Inherit" option, saved through the same admin write path already gated by `admin:roles`. It delivers the admin-facing configuration surface only; the server-side resolution that actually applies a configured effort to a running agent is FEAT-003, and the artifact/cost-history display of the effort that ran is FEAT-004 — both build on the columns this feature's fields are written to and read from.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-001 | PBI | Set a default effort level per agent module in Project Settings | Must Have |
| TBI-004 | TBI | Extend project-settings admin API and UI with per-module effort fields | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- One effort dropdown (Low / Medium / High / Inherit) per existing Cursor-backed module override in Admin → Project Settings, saved through the existing project-settings write form.
- One project-wide "Default Effort" fallback field, mirroring the existing "Default Model" field.
- Server-side validation of every `*Effort` field against the closed `low`/`medium`/`high`/`null` allow-list on the existing admin write endpoint, returning 400 on any other value.
- The skill-config read endpoint (`GET /api/skill-config`) and the admin list endpoint (`GET /api/admin/project-settings`) returning the new effort fields so the UI can display current defaults.

**Out of scope:**
- A runtime effort picker for end users at interview start, Agent Home, or any other kickoff surface — this feature is Project-Admin-only defaults (Feature `outOfScope`, PBI-001 `outOfScope`).
- Per-user or per-interview effort overrides — this is a project-wide, per-module default only (PBI-001 `outOfScope`).
- Actually resolving a configured effort at kickoff and passing it to the Cursor SDK — that is FEAT-003 ("Server-Authoritative Effort Resolution at Kickoff").
- Snapshotting the resolved effort on artifacts or usage events, and displaying it on artifact headers / AI Cost Analytics — that is FEAT-004.
- Effort support for Bedrock-only stages (PRD review, Design Prototype/UI Lab Bedrock generation, Design Plan) — those keep their existing max-tokens/timeout/temperature knobs (Epic `outOfScope`).
- Any new RBAC permission key, new settings screen, or database migration — this feature reuses `admin:roles` and the columns FEAT-001 already adds.

---

## Target Surface

**Primary surface:** Full-stack (React client `AdminProjectSettings.tsx` + Express `admin.ts`/`api.ts` routes + `projectSettingsService.ts`)

**Experience notes:** The only new UI is one effort selector per module inside the existing Admin → Project Settings screen, next to that module's existing model override, plus one project-wide "Default Effort" field next to "Default Model." No new pages, routes, or navigation entries. Saving is part of the same form submission that already saves the model override — there is no separate save action or confirmation step for effort.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Set or change a module's default effort (or the project-wide default effort) | Project Admin (`admin:roles`) | Project-scoped |
| View the currently configured effort defaults on the Project Settings screen | Project Admin (`admin:roles`) — same gate as viewing the rest of that screen | Project-scoped |

**Feature flag:** `None` — rollout: GA from launch
**Behavior when flag is off:** Not applicable. Every `*Effort` column defaults to `null` (Inherit) until a Project Admin explicitly sets a value, so existing behavior is unchanged for every project until an admin opts in — this is the PRD's stated reason no flag is needed.

---

## Acceptance Criteria

### PBI-001 — Set a default effort level per agent module in Project Settings

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am a Project Admin viewing a module's settings card in Project Settings | I select Medium as that module's effort and save | The module's effort default is persisted and the card shows Medium next to the existing model selection |
| (b) Error/failure | I am a Project Admin | I submit an effort value outside low, medium, high, or Inherit | The save request is rejected with a 400 error and no value is persisted |
| (c) Edge case/boundary | A module's effort was previously set to High | I change it back to Inherit and save | The stored value becomes null and that module falls back to the project default effort, then to the Cursor SDK default |
| (d) Negative scenario | I am a user without `admin:roles` for the project | I attempt to call the project-settings write endpoint with an effort value | The request is denied and no effort default is changed |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/admin/project-settings` | `AdminProjectSettings.tsx` | Set/clear a per-module effort default and the project-wide default effort | Extend existing |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `PipelineStageCard` (extended) | Adds an "Effort override" `<select>` next to each stage's existing "Model override" `<select>`, for every stage that declares an `effortKey` | None beyond the existing form's pending/disabled state during save | Inline via the existing save-error banner (`upsert.isError`) — no new error surface | Renders "Inherit (project default)" as the selected option when the stored value is `null` |
| Standalone ADR effort field (extended) | Adds "ADR effort override" beside the existing standalone "ADR model override" field (ADR's model/skill fields are not routed through `PipelineStageCard`) | Same as above | Same as above | Same as above |
| Standalone "Default Effort" field (extended) | Adds a project-wide fallback selector beside the existing "Default Model" field in the Repository & Defaults section | Same as above | Same as above | Renders "Use Cursor SDK default" when `defaultEffort` is `null` |

**Validation rules:**
- Effort selector: only `Low`, `Medium`, `High`, or `Inherit` (mapped to `low`/`medium`/`high`/`null`) are selectable in the UI, and the same closed set is enforced server-side on save — a client cannot bypass validation by editing the request body directly, because `admin.ts` re-validates every `*Effort` field before calling `upsertSkillConfig`.

**Accessibility:**
- Each effort `<select>` has an explicit `<label htmlFor="ps-{effortKey}">Effort override</label>` pairing, identical in structure to the adjacent `<label htmlFor="ps-{modelKey}">Model override</label>`, so it inherits the same keyboard-navigable, screen-reader-labeled behavior already verified for the model dropdown.

**data-testid attributes:**
- `data-testid="ps-stage-effort-{effortKey}"` — the per-stage effort `<select>` (mirrors `ps-stage-model-{modelKey}`)
- `data-testid="ps-adrEffort"` — the standalone ADR effort `<select>`
- `data-testid="ps-defaultEffort"` — the standalone project-wide default-effort `<select>`

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
