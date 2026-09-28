# Design — Configure Home Pill Allow-Lists

> **PRD slug:** `home-pill-access-control` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Home Pill Access Control | **Affected personas:** Project Admin
> **Open items:** See [configure-home-pill-allow-lists-assumptions.md](configure-home-pill-allow-lists-assumptions.md) (2 unresolved)

---

## Feature Summary

**Description:** Today every Home skill pill and MCP pill configured for a project is visible and startable by anyone with Home access — there is no way to hand a narrow group of users a single-purpose entry point without exposing every other shortcut on the project. This Feature gives Project Admins a per-pill allow-list: an optional set of specific users and/or groups on each Home skill pill and MCP pill, configured directly in the existing Admin → Project Settings pill editor. A pill with no allow-list keeps behaving exactly as it does today (visible to everyone with Home access); a pill with an allow-list is scoped to only the listed users and groups once **Enforce Home Pill Access** (the dependent Feature) ships. This Feature covers only the data model and the admin configuration surface — no Home-facing visibility or thread-creation enforcement changes yet.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-001 | PBI | Restrict a Home skill pill to specific users or groups | Must Have |
| PBI-002 | PBI | Restrict a Home MCP pill to specific users or groups | Must Have |
| TBI-001 | TBI | Add allow-list fields to Home pill storage and shared types | Must Have |
| TBI-002 | TBI | Extend Admin Project Settings pill editor with allow-list controls | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- Two optional fields — individual user identifiers and group identifiers — added to the shared skill-pill and MCP-pill types.
- The admin project-settings read and write path returning and persisting the full pill list, including these new fields, exactly as it does today for every other pill attribute.
- A user/group selection control on each skill pill row and each MCP pill row in the Admin Project Settings pill editor, following the existing reviewer/approver pool picker pattern.
- BR-001 (empty allow-list means everyone with Home access) as a data-model default — enforced by this Feature only in the sense that "no allow-list" and "empty allow-list" persist identically; runtime enforcement of BR-001 ships in **Enforce Home Pill Access**.

**Out of scope:**
- Bulk-editing allow-lists across multiple pills at once (PBI-001, PBI-002).
- Restricting Interview, ADR, or any other non-Home skill selector (Feature-level).
- Validating that an allow-listed user or group belongs to the project being configured (Feature-level).
- Filtering the public `GET /api/skill-config` response, evaluating pill access for Home visibility, or enforcing allow-lists on Home thread creation — all of this is **Enforce Home Pill Access** (the dependent Feature, `dependsOn: ["FEAT-001"]`).
- A new RBAC permission key — this Feature reuses the existing `admin:roles` write gate.
- A feature flag or staged rollout — ships GA directly, same as the parent epic.

---

## Target Surface

**Primary surface:** Full-stack (shared types + existing admin read/write path + React admin editor). No new Express service, no new route, and no database migration.

**Experience notes:** The only visible UI change is inside **Admin → Project Settings → Project Skill Settings**, in the existing "Quick Skill Pills" and "Quick MCP Pills" accordion sections — each already-configured pill row gains a user/group picker. Home itself (the composer, pill visibility, and thread creation) is untouched until **Enforce Home Pill Access** ships; a Project Admin who sets an allow-list in this Feature will not yet see any change in who can use that pill on Home.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Configure a Home pill's allow-list | Project Admin (existing `admin:roles` gate, enforced by `router.use(requirePermission('admin:roles'))` on `src/server/routes/admin.ts`) | Project-scoped |
| View a Home pill's allow-list (admin editor) | Project Admin (same `admin:roles` gate — the admin read path is intentionally unfiltered) | Project-scoped |

**Feature flag:** `None` — rollout: GA from launch, matching the parent epic.
**Behavior when flag is off:** Not applicable — no flag exists for this Feature.

---

## Acceptance Criteria

### PBI-001 — Restrict a Home skill pill to specific users or groups

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am a Project Admin editing a Home skill pill in Project Settings | I add one or more users or groups to the pill's allow-list and save | The allow-list is persisted, and only those users (directly or via group membership) see and can start that pill on Home *(visibility/start enforcement itself ships in Enforce Home Pill Access; this Feature guarantees the persisted allow-list round-trips correctly)* |
| (b) Error/failure | I am a Project Admin editing a pill's allow-list | I submit the change and the save request fails | The previously saved allow-list remains in effect and I see an error indicating the save did not succeed |
| (c) Edge case/boundary | A Home skill pill has no users or groups on its allow-list | Any user with Home access loads Home | That pill is visible to them, matching today's behavior |
| (d) Negative scenario | A caller without Project Admin access to project settings | They call the admin write endpoint directly to change a pill's allow-list | The request is denied and no allow-list change is persisted |

### PBI-002 — Restrict a Home MCP pill to specific users or groups

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am a Project Admin editing a Home MCP pill in Project Settings | I add one or more users or groups to the pill's allow-list and save | The allow-list is persisted, and only those users (directly or via group membership) see and can start that MCP pill on Home |
| (b) Error/failure | I am a Project Admin editing an MCP pill's allow-list | I submit the change and the save request fails | The previously saved allow-list remains in effect and I see an error indicating the save did not succeed |
| (c) Edge case/boundary | A Home MCP pill has no users or groups on its allow-list | Any user with Home access loads Home | That MCP pill is visible to them, matching today's behavior |
| (d) Negative scenario | A caller without Project Admin access to project settings | They call the admin write endpoint directly to change an MCP pill's allow-list | The request is denied and no allow-list change is persisted |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/admin/project-settings` | Project Skill Settings — "Quick Skill Pills" accordion | Admin sets/clears a skill pill's allow-list | Extend existing |
| `/admin/project-settings` | Project Skill Settings — "Quick MCP Pills" accordion | Admin sets/clears an MCP pill's allow-list | Extend existing |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `GroupAwarePeoplePicker` (reused, unmodified) | Search/select users and groups for a pill's allow-list, rendered per pill row | Disabled while `upsert.isPending`, matching every other pill control | Save failure surfaces through the existing form-level error path (AC (b)); the picker itself has no independent error state | "No groups or people selected" (existing built-in empty state — means "everyone with Home access") |

**Validation rules:**
- No client-side format validation on selected IDs — the picker only ever emits real `oid`/group-`id` values already present in the loaded `allUsers`/`groupsWithMembers` data, so malformed input is not reachable through the UI.
- No minimum or maximum allow-list size.

**Accessibility:**
- `GroupAwarePeoplePicker` is already keyboard-navigable (search input, arrow-selectable dropdown options, removable chips with `aria-label`) and this is unchanged by reuse — satisfies PBI-001/PBI-002's NFR "keyboard-navigable and screen-reader labeled, matching the existing pill editor fields."

**data-testid attributes:**
- `data-testid="ps-skill-pill-allowlist-{idx}"` — the allow-list picker wrapper on skill pill row `idx`.
- `data-testid="ps-mcp-pill-allowlist-{idx}"` — the allow-list picker wrapper on MCP pill row `idx`.

---

## Technical Specification

See [configure-home-pill-allow-lists-tech-spec.md](configure-home-pill-allow-lists-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
