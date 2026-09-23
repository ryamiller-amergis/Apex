# Design — Enforce Home Pill Access

> **PRD slug:** `home-pill-access-control` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Home Pill Access Control | **Affected personas:** Authenticated User, Project Admin, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (2 unresolved)

---

## Feature Summary

**Description:** Every Home skill and MCP pill is visible and startable by anyone with Home access today, with no way to point a single user at one skill without handing them every other shortcut on the project. This Feature closes that gap on the *consuming* side of Home: once a Project Admin configures a per-pill allow-list (delivered by the companion Feature, "Configure Home Pill Allow-Lists"), Authenticated Users see and can start only the pills their allow-list permits, Platform Admin continues to see and start every configured pill to verify configuration, and Project Admin — outside the pill editor itself — follows the same allow-lists as anyone else. Enforcement closes every path a restricted user could otherwise reach a skill through: the visible pill list, direct thread-creation calls that bypass the Home composer, and free-form pill-less chat when a project's pills leave the caller with nothing they're allowed to start.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-003 | PBI | See only the Home pills I'm allowed to use | Must Have |
| PBI-004 | PBI | See every Home pill as Platform Admin | Must Have |
| PBI-005 | PBI | Home thread creation denies an unauthorized pill | Must Have |
| PBI-006 | PBI | Blocked from starting a Home thread with no allowed pills | Must Have |
| PBI-007 | PBI | Continue using a Home thread after losing pill access | Must Have |
| TBI-003 | TBI | Build a pill access resolver for live allow-list evaluation | Must Have |
| TBI-004 | TBI | Filter and strip Home pills on the public skill-config read path | Must Have |
| TBI-005 | TBI | Enforce pill access on Home thread creation | Must Have |
| TBI-006 | TBI | Update Home composer for filtered pills and blocked-start state | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- Filtering the Home skill-pill and MCP-pill arrays returned by the public skill-config read path down to the pills the requesting caller is allowed to use, with allow-list identifiers never present on that response.
- Platform Admin (Super Admin) seeing and starting every configured Home pill unfiltered, verified against the existing super-admin identity check.
- Denying Home thread creation when a kickoff names a pill the caller isn't allowed on, or when the caller is allowed on none of a project's configured pills and sends a pill-less kickoff.
- Allowing pill-less Home thread creation unchanged when a project has no configured pills at all.
- Leaving an already-created thread's read/write access, and the thread-creation resolver's one-time-at-creation scope, untouched — access changes never interrupt an in-progress conversation.

**Out of scope:**
- Bulk-editing allow-lists across multiple pills at once (companion Feature, "Configure Home Pill Allow-Lists").
- Filtering any skill-config field other than the Home pill arrays — Interview, ADR, and other consumers of the same read path are unaffected.
- Re-checking pill access on every follow-up message of an existing thread — access is enforced only at thread creation.
- Hiding or blocking a user's access to their own thread history when their pill access is later removed.
- A new RBAC permission key — enforcement layers on the existing `home:view` and `chat:create` gates.
- A feature flag or staged rollout — this ships GA directly.
- Extending the Platform Admin bypass to the admin pill-editor experience, which already shows every pill to Project Admin regardless of this Feature.

---

## Target Surface

**Primary surface:** Full-stack (both client and server)

**Experience notes:** Home is the only surface affected. The Home composer (`ChatAgentPanel.tsx`) gains a new blocked-start state; Interview, ADR, and every other skill-selection surface that shares the skill-config read path are unchanged. The Admin Project Settings pill editor is out of scope here — it belongs to the companion "Configure Home Pill Allow-Lists" Feature and already shows every pill to Project Admin.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| View Home pills | Authenticated User (`home:view`) | Project-scoped |
| Start a Home thread | Authenticated User (`chat:view` + `chat:create`) | Project-scoped |
| Bypass Home pill allow-lists on Home | Platform Admin (Super Admin) | Global |
| See every pill unfiltered while editing (unaffected by this Feature) | Project Admin, via the existing pill editor | Project-scoped |

**Feature flag:** `None` — GA from launch.
**Behavior when flag is off:** Not applicable — no flag gates this Feature.

---

## Acceptance Criteria

### PBI-003 — See only the Home pills I'm allowed to use

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A project has pills with different allow-lists and I am on some but not all of them | I load Home | I see only the pills whose allow-list includes me directly or through a group I belong to, or that have no allow-list at all |
| (b) Error/failure | A pill's allow-list references a group that no longer exists | Pill visibility is evaluated for me | That group grants no access rather than the request failing |
| (c) Edge case/boundary | A project has no configured Home pills at all | I load Home | I see the existing pill-less Home experience, unchanged |
| (d) Negative scenario | I am allowed on zero of the project's configured pills | I load Home | Both the skill pill and MCP pill arrays returned to me are empty, and no allow-list identifiers appear anywhere in the response |

### PBI-004 — See every Home pill as Platform Admin

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am a Platform Admin (Super Admin) and a project has pills with non-empty allow-lists I am not on | I load Home | I see every configured skill and MCP pill for that project, unfiltered |
| (b) Error/failure | My session cannot be verified as a Platform Admin (Super Admin) identity | Home pills are resolved for me | I am treated as a regular user subject to allow-lists, not granted the bypass |
| (c) Edge case/boundary | A project has no configured Home pills at all | I load Home as a Platform Admin | I see the same pill-less Home experience as any other user |
| (d) Negative scenario | I am a Project Admin, not a Platform Admin, and I am not on a pill's allow-list | I load Home | That pill is not shown to me, even though I can see and edit it in Project Settings |

### PBI-005 — Home thread creation denies an unauthorized pill

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am allowed on a specific configured Home skill pill | I start a Home thread naming that pill's skillPath | The thread is created |
| (b) Error/failure | I am not allowed on a specific configured Home MCP pill | I call the thread-creation endpoint directly naming that pill's MCP identity, bypassing the Home composer | The request is denied and no thread is created |
| (c) Edge case/boundary | A kickoff names a skillPath that does not match any pill configured for the project | I attempt to start a Home thread with it and I am not allowed on any configured pill | The request is denied |
| (d) Negative scenario | I am a Platform Admin (Super Admin) | I start a Home thread against any configured pill | The thread is created regardless of that pill's allow-list |

### PBI-006 — Blocked from starting a Home thread with no allowed pills

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A project has configured Home pills and I am allowed on none of them | I try to start a new Home thread with no pill selected | The request is denied and I see an explanation that I have no available Home skills |
| (b) Error/failure | I bypass the disabled Home composer and call the create endpoint directly with no skillPath and no MCP identity | The project has pills and I am allowed on none | The server still denies the request |
| (c) Edge case/boundary | A project has no configured Home pills at all | I start a new Home thread with no pill selected | The thread is created as pill-less chat, unchanged from today |
| (d) Negative scenario | I am allowed on at least one configured pill | I try to start a new Home thread with no pill selected | The pill-less request is still evaluated on its own terms and is not denied purely because other pills exist |

### PBI-007 — Continue using a Home thread after losing pill access

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I started a Home thread on a pill I was allowed on at the time | An admin later removes me from that pill's allow-list and I send another message on the same thread | My message is accepted and the conversation continues |
| (b) Error/failure | A thread is owned by someone else | I attempt to open or write to it | Access is denied by the existing thread-ownership rules, unrelated to pill access |
| (c) Edge case/boundary | My access to a pill was removed after I started a thread on it | I click New Chat and try to start a fresh thread on that same pill | The new thread creation is denied, even though my existing thread on that pill still works |
| (d) Negative scenario | My access to a pill was removed | I reopen my existing thread on that pill from Thread History | I can view the full prior conversation and send new messages without being blocked |

---

## UI/UX

**Routes / screens:**

| Route | Screen | Action | New or extend existing |
|-------|--------|--------|----------------------|
| `/home` | `ChatAgentPanel.tsx` (Home compose view) | Pill selection renders only the caller's filtered pills; free-form send is disabled with an explanatory message when the project has pills and the caller's filtered lists are both empty | Extend existing |

**Component breakdown:**

| Component | Purpose | Loading state | Error state | Empty state |
|-----------|---------|--------------|-------------|-------------|
| `ChatAgentPanel.tsx` (Home compose branch) | Renders `quickSkillPills`/`quickMcpPills` from the already-filtered `skill-config` response; blocks pill-less send when the caller is allowed on none of the project's configured pills | Existing `useProjectSkillConfig` loading state — composer defaults to the disabled/blocked state (fail-safe) while the query is in flight | Existing skill-config fetch error handling — composer defaults to the disabled/blocked state rather than an unchecked send | New: "You don't have access to any Home skills on this project. Ask a Project Admin to add you to a pill's allow-list." message when the caller is allowed on zero configured pills |

**Validation rules:**
- Free-form send in the empty-composer view is disabled whenever `homePillsConfigured` is `true` and the caller's filtered `quickSkillPills` and `quickMcpPills` are both empty — mirroring the existing `needsSkillSelection` gate already applied when pills exist and none is selected.
- The existing `needsSkillSelection` gate (a pill exists but none is selected yet) and the new blocked-state gate are mutually exclusive: the blocked state only applies when the caller's filtered pill arrays are empty, which by definition means there is nothing to select.

**Accessibility:**
- The blocked-state message renders through the composer's existing `role="status"`/`aria-live` pattern already used for other inline explanatory text (e.g. `chat-agent-empty-transcript`), so screen readers announce it without additional wiring.
- No new interactive controls are introduced — the composer's existing `AgentComposer` `disabled`/`canSend` props already drive both keyboard and screen-reader affordances.

**data-testid attributes:**
- `data-testid="chat-agent-home-blocked-notice"` — the new explanatory message shown when the caller has no allowed Home pills on a project that has configured pills.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
