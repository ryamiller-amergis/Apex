# Design — Evaluation Permissions and Rollout Gate

> **PRD slug:** `human-workflow-evaluation-for-interviews-and-prds` | **Priority:** Must Have | **Feature flag:** `workflow-human-evaluation`
> **Parent Epic:** Evaluation Foundations | **Affected personas:** Platform Admin, Product-Owner, BA, Manager, Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Human workflow evaluation is optional feedback on AI-generated Interview and PRD output. This Feature decides who can use it and where it is on. Two new RBAC permissions (`workflow-evaluation:view`, `workflow-evaluation:submit`) control who reads and submits feedback, and a Feature Flag (`workflow-human-evaluation`) lets a Platform Admin turn the whole capability on or off per project. When the flag is off, no evaluation screen, route or background job exists for that project, and Interview and PRD work run as they do today.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-004 | TBI | Add workflow-evaluation view and submit permissions | Must Have |
| TBI-005 | TBI | Gate evaluation routes and UI on the workflow-human-evaluation flag | Must Have |

This Feature has no PBIs. Acceptance criteria below are written per TBI.

---

## Scope and Out-of-Scope

**In scope:**
- Create the permission keys `workflow-evaluation:view` and `workflow-evaluation:submit` (migration, documented catalog entry, shared key constants, route guards, listing in Admin → Roles) and grant both to the `admin` and `member` roles by default.
- Register the `workflow-human-evaluation` flag, targeted at the Apex (project) by default, with a Platform Admin kill switch.
- Server guards that every evaluation route, retry, export and hub route mounts: reject a body that names a project, check permission, check project assignment, check the flag.
- A client access hook that combines the flag, `can()` and the selected project so each feedback surface, the Workflow evaluations page and the hub can hide themselves when access is missing.
- A warning in Admin → Roles when a role holds submit without view.

**Out of scope:**
- A separate workflow-evaluation admin permission. Project Admin access reuses the existing `admin:roles` permission; Platform Admin reuses the super-admin check.
- Project-setting toggles for required stages.
- The evaluation service, router, jobs, feedback form, Workflow evaluations page, hub and alerts. Those belong to other Features, which mount the guards this Feature supplies.
- Denormalized latest-review columns on PRDs or Interviews, and project-specific definition overrides (Epic-level exclusions).
- Per-project rubric forks, Teams or digest notifications, and any gate on Interview phase advance, PRD generation or approval.

---

## Target Surface

**Primary surface:** Full-stack

**Experience notes:** Almost all of this Feature is invisible when it works. Users see it in three places: the Admin → Roles screen lists and grants the two new permissions; every feedback surface (Quality feedback tab, panel, modal, banner), the Workflow evaluations page and the Platform Admin hub appear only when the flag is on and the user holds the permission; and a role that holds submit without view shows a warning. Feedback is always optional and skippable.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| View definitions, event history and job diagnostics on an artifact | Holders of `workflow-evaluation:view` (default: `admin` and `member` roles, which cover Product-Owner, BA, Manager and Developer users) | Project-scoped |
| Submit a human evaluation | Holders of both `workflow-evaluation:submit` and `workflow-evaluation:view` (default: `admin` and `member` roles). Help text names the Interview initiator and PRD owner as expected submitters; the server does not enforce it | Project-scoped |
| Open the Workflow evaluations page, filter events, read judge recommendations | Anyone who can open Project Admin for the project (`admin:roles`), or a Platform Admin | Project-scoped |
| Export events as JSON or CSV | Anyone who can open Project Admin for the project, or a Platform Admin | Project-scoped |
| Retry a failed diagnostic job | Anyone who can open Project Admin for the project, or a Platform Admin | Project-scoped |
| View the cross-project hub | Platform Admin | Global |
| Receive regenerate and reject alerts | Project Admins of the project | Project-scoped |
| Grant or revoke the two permission keys | Project Admin through Admin → Roles (`admin:roles`) | Project-scoped through project roles, or global |
| Turn the flag on or off, add or remove pilot projects | Platform Admin through Platform Admin → Feature Flags | Global |

**Feature flag:** `workflow-human-evaluation` — rollout: Internal → Beta → GA. On first for the Apex (project), then named pilot projects, then widened through Platform Admin targeting. Kill switch owner: Platform Admin.

**Behavior when flag is off:** No Quality feedback tab, panel, modal or banner appears. The Workflow evaluations page and the Platform Admin hub are hidden. Evaluation routes answer `404 Not found` and no jobs start. Interview, PRD review and approval work as they do today. Permissions still apply when the flag is on. A Platform Admin does not bypass the flag. A diagnostic job already running when the flag goes off finishes and stores its result; no new job starts.

---

## Acceptance Criteria

### TBI-004 — Add workflow-evaluation view and submit permissions

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Both migrations are applied. A user in project Apex holds the `member` role | The user calls an evaluation read route with `?project=Apex`. A Project Admin opens Admin → Roles | The read route passes the permission guard. Admin → Roles lists `workflow-evaluation:view` and `workflow-evaluation:submit`, shows the `admin` and `member` roles holding both, and lets the Project Admin grant and revoke each key |
| (b) Error/failure | A user holds only the `viewer` role, or a custom role with `workflow-evaluation:submit` but not `workflow-evaluation:view` | The user calls a read route, or posts a new evaluation | The server answers `403 { error: 'Forbidden', missing: [...] }` naming the missing key, and no evaluation service code runs |
| (c) Edge case/boundary | A user's global role is `member` but the user has a project-specific role for project Beta that holds neither key | The same user calls an evaluation route for Beta, then for Apex | Beta answers 403, because the project role replaces the global role for that project. Apex answers as allowed when the user's roles for Apex hold the keys |
| (d) Negative scenario | A user holds both keys in project Apex and is not assigned to project Beta | The user sends `x-apex-project: Beta`, or sends `x-apex-project: Beta` with `project: "Apex"` in the JSON body | The first request answers 403 (not assigned). The second answers 400 and nothing runs, because a body that names a project is rejected |

### TBI-005 — Gate evaluation routes and UI on the workflow-human-evaluation flag

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The flag is enabled with a `project` rule for Apex. The user holds the keys and is assigned to Apex | The user opens a PRD review view or an Interview chat view in Apex, and an evaluation route is called | The feedback surfaces render, and the route passes the flag check |
| (b) Error/failure | The flag service throws while evaluating (for example the database is unreachable) | A client calls an evaluation route, and the browser asks for flags | The route answers 500 and starts nothing. The client receives no flags and renders no evaluation UI. Interview and PRD pages stay usable |
| (c) Edge case/boundary | The flag was on a few seconds ago and a Platform Admin has just turned it off. The browser still holds the flag value for up to 60 seconds | A user submits or lists feedback in that window | The server answers 404 and no job starts. The client clears its cached flag value on that 404 and hides the surface. A diagnostic job already running finishes and stores its result |
| (d) Negative scenario | The flag has no rule for project Beta (or is disabled) and the caller is a Platform Admin in Beta | The caller opens a Beta Interview or PRD and calls an evaluation route | No evaluation UI renders, the route answers 404, and Interview, PRD review and approval requests answer exactly as before |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/admin/roles` | Admin → Roles (`AdminRoles`) | Project Admin grants or revokes `workflow-evaluation:view` and `workflow-evaluation:submit` on a role; sees a warning when a role holds submit without view | Extend existing |
| `/platform-admin` | Platform Admin → Feature Flags (`PlatformAdmin`) | Platform Admin adds pilot project rules and toggles the `workflow-human-evaluation` kill switch. No code change: the flag appears in the existing list once seeded | Extend existing (no change) |

All other screens that depend on this gate (PRD review tab, Interview panel, Workflow evaluations page, hub) are built by other Features. They call the access hook below at their entry point and render nothing when it reports no access.

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `AdminRoles` → `PermissionsModal` and `RoleMembersModal` (existing) | The permissions dialog lists the two keys under a `workflow-evaluation` group with no code change, because it groups every permission by `category`. It also shows the submit-without-view warning, live while the box states conflict and again after save. The members dialog shows the same warning after a user is added to such a role | Existing "Loading roles…" text | Existing inline error box | Not applicable |
| `useWorkflowEvaluationAccess(project)` (new hook, no markup) | Returns `{ flagEnabled, canView, canSubmit, canAdmin, isPlatformAdmin, ready }` for feedback surfaces to branch on | `ready = false`: surfaces render nothing | Flag query error: `flagEnabled = false`: surfaces render nothing | Not applicable |

**Validation rules:**
- Permissions dialog: while `workflow-evaluation:submit` is checked and `workflow-evaluation:view` is not, an inline warning shows: "Submit permission is present without view permission; members can submit feedback but the form cannot load its definitions." Saving is not blocked, because a Project Admin may intend it. After save, the dialog stays open on the warning with an "Acknowledge and Close" button, the same flow `playbooks:author` without `playbooks:run` uses today. Adding a user to such a role in the members dialog shows the warning too.
- Server: any evaluation request whose JSON body contains a `project` field answers 400 `{ error: 'project must not be sent in the request body' }`. The project comes from the `?project=` query or the `x-apex-project` header only.

**Accessibility:**
- The live warning in the permissions dialog uses `role="status"` with `aria-live="polite"`; the after-save warning and the members dialog warning use `role="alert"`. This matches the playbook warning.
- The keys render as checkboxes inside the existing `permRow` label: key name plus description, reachable by keyboard.
- The Save button gets `aria-describedby` pointing at the warning while it shows.
- Feedback surfaces that depend on this gate render nothing when it denies access, so there is no focusable element and no empty landmark to announce.

**data-testid attributes:**
- `data-testid="role-permission-workflow-evaluation-view-checkbox"` — view-key checkbox in the permissions dialog (generated by the existing `AdminRoles` rule from the key; no code needed)
- `data-testid="role-permission-workflow-evaluation-submit-checkbox"` — submit-key checkbox in the permissions dialog (same rule)
- `data-testid="workflow-evaluation-submit-without-view-warning"` — the submit-without-view warning, in both the permissions dialog and the members dialog

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
