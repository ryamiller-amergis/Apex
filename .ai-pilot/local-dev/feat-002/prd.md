<!-- apex-grounded-sha:e61f44bb9a311b601902eb8db3c9f49b42b50f93 -->

> Based on the **Apex** project, **main** branch, as of Sep 14, 2026.
---
title: Home Pill Access Control
slug: home-pill-access-control
created: 2026-09-14
triage-status: needs-triage
glossary-terms-used:
  - Skill Pill
  - Agent Home
  - RBAC
  - Project Admin
  - Platform Admin
  - Super Admin
---

# Home Pill Access Control

## Problem Statement

Every Home skill and MCP pill is visible and usable by anyone with Home access, with no way to point a user at a single skill without also handing them every other shortcut on the project. A team that wants to give some users a narrow, single-purpose entry point — for example, letting analysts ask the Knowledge skill about measure definitions without exposing PRD generation, design tooling, or any other pill — has no configuration lever today, and admins cannot restrict access by user or group on a per-pill basis.

## Solution

Project Admins can configure an allow-list of users and/or groups on any Home skill pill or MCP pill, for any Apex project. A pill with no allow-list stays visible to everyone with Home access, exactly as it behaves today; a pill with an allow-list is only shown to, and only startable by, the users and groups on that list, evaluated live against current project membership. Home enforces the same rule when a thread is created — including blocking a user from starting a free-form Home chat when a project has pills configured and that user is allowed on none of them — while Platform Admin (Super Admin) always sees and can start every pill, and a user who already has a thread open keeps using it even if their access to that pill changes later.

## Implementation Decisions

- A pill access resolver (deep module) computes, for a given project's configured Home pills and a given caller's identity, (a) the subset of skill and MCP pills that caller may use, and (b) whether that caller may start a Home thread at all given the project's pill configuration. It encapsulates the "empty allow-list means everyone" default, live user and group membership evaluation, and the Platform Admin (Super Admin) bypass in one place so every caller of this logic gets the same answer instead of re-implementing the rule.
- The existing per-project pill records (skill pills and MCP pills) gain two optional allow-list fields each — one for individual user identifiers and one for group identifiers. These live inside the same JSON-backed pill arrays already stored on the project's skill settings row; no new tables and no new columns are introduced.
- The public skill-config read path runs every Home pill it would otherwise return through the pill access resolver, keeps only the pills the caller may use, and omits the allow-list fields from each returned pill so a non-admin caller can never see who else is allowed on a pill. Every other field on that response — interview options, model selections, and all non-Home-pill configuration — is unchanged, so Interview, ADR, and other consumers of the same read path are unaffected.
- The admin project-settings read and write path is intentionally left returning and persisting the full pill list, including allow-list fields, exactly as it does today for every other pill attribute — only the public read path is filtered.
- Home thread creation runs the same pill access resolver before a thread is persisted: a kickoff is accepted only when it names an allowed configured pill (skill or MCP), or carries no pill and the caller is allowed to start Home chat at all under the project's current pill configuration; every other kickoff is denied with an explicit error. Platform Admin (Super Admin) is exempt from this check. The resolver is invoked only at creation — reopening or continuing a thread the caller already owns, and sending further messages on it, are explicitly untouched, so access changes never interrupt an in-progress conversation.
- The Admin Project Settings pill editor gains a user/group selection control on each pill row (skill and MCP), following the same picker pattern already used to build reviewer and approver pools elsewhere in project settings, so an admin sets or clears an allow-list without leaving the pill editor.
- The Home composer reads the already-filtered pill arrays from the skill-config response and mirrors the "project has pills, caller allowed on none" rule client-side, disabling send in that state for a clear experience; the server-side check in thread creation remains the actual enforcement boundary.

## Testing Decisions

- **What makes a good test here:** Assert on the visible pill set and on thread-creation accept/deny outcomes for a given caller and allow-list configuration, not on which internal helper was called or in what order.
- **Modules to test:**
  - Pill access resolver — the empty-list-means-everyone default, live user and group membership evaluation, and the Platform Admin bypass, each exercised directly through its inputs and outputs.
  - Skill-config read path — that only allowed pills are returned and that allow-list fields never appear on the public response, across Authenticated User, Project Admin, and Platform Admin callers.
  - Home thread-creation path — the full accept/deny matrix across an allowed pill, a disallowed pill, no pill on a project with no configured pills, and no pill on a project where the caller is allowed on none.
- **Prior art:** Follows the existing pattern used for reviewer and approver pools, which store group references and expand them to current members at read time rather than snapshotting membership when a pool is saved.

## Target Surface

- **Primary surface:** Full-stack (both client and server)
- **Experience notes:** Home is the only surface affected; the pill editor in Admin Project Settings and the Home composer both gain visible changes, but Interview, ADR, and other skill-selection surfaces are unchanged.

---

## Access Control and Permissions

| Action | Required group(s) / role(s) | Data scope |
|--------|---------------------------|-----------|
| Configure a Home pill's allow-list | Project Admin (existing `admin:roles` gate) | Project-scoped |
| View Home pills | Authenticated User (`home:view`) | Project-scoped |
| Start a Home thread | Authenticated User (`chat:create`) | Project-scoped |
| Bypass Home pill allow-lists on Home | Platform Admin (Super Admin) | Global |

---

## Security and Data Sensitivity

- **Sensitive fields:** None. Allow-lists reference the same internal user and group identifiers a Project Admin can already see in Project Settings and the reviewer/approver pools.
- **Handling requirements:** Exclude `allowedUserIds` and `allowedGroupIds` from the public `GET /api/skill-config` response for every pill it returns; the admin read/write path keeps the full lists, reachable only through the existing admin gate.
- **Data scope enforcement:** Pill configuration and allow-list evaluation are always scoped to the selected project's skill settings row, the same scoping already used for every other per-project skill and model setting.

---

## Non-Functional Requirements

- **Response time:** Not specified — no new external calls are introduced; the resolver adds only in-memory list checks and existing membership lookups to calls that already run today.
- **Concurrency:** Not specified — pill counts and allow-list sizes remain small (single digits), consistent with existing Home usage.
- **Data volume:** Not specified — each pill's allow-lists are expected to hold a handful of user or group identifiers.

---

## Feature Flag

- **Flag required:** No
- **Flag name:** None
- **Rollout sequence:** GA from launch
- **Kill switch owner:** Not applicable
- **Behavior when disabled:** Not applicable

---

## Out of Scope

- Applying allow-lists to Interview, ADR, or any other skill/model selector outside Home pills.
- A separate project-level "restricted Home users" list that limits a user to only their explicitly allow-listed pills, independent of any specific pill (considered during the interview and deferred to keep this within one epic and two features).
- Re-checking pill access on every follow-up message of an existing thread — access is enforced only at thread creation.
- Hiding or blocking a user's access to their own thread history when their pill access is later removed.
- A new RBAC permission key — enforcement layers on the existing `home:view` and `chat:create` gates.
- A feature flag or staged rollout — this ships GA directly.

## Assumptions Made

- "Super Admin" in the originating conversation maps to the Platform Admin persona for backlog and persona classification; the bypass behavior described (seeing and starting every Home pill) is scoped to Apex's existing super-admin bypass, and does not extend to every user holding the Project Admin role — Project Admin follows the same allow-lists as any other user on Home.
- Group allow-list membership reuses the existing project groups membership model; no new group type or membership table is introduced.
- A configured Home pill "match" for enforcement purposes is a `skillPath` equal to a configured skill pill's `skillPath`, or an MCP kickoff whose server identity equals a configured MCP pill's `mcpServerName`; any other kickoff is treated as pill-less for enforcement purposes.
- Admin-side allow-list entries are validated only for being well-formed identifiers; validating that a referenced user or group actually belongs to the project being configured is not required by this PRD and should be confirmed with the admin experience owner.
- No database migration is required — the allow-list fields are added inside the existing JSON-backed pill arrays already stored on the project's skill settings row.
