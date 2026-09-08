# Design — Server-Authoritative Effort Resolution at Kickoff

> **PRD slug:** `per-module-agent-effort-defaults` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Per-Module Agent Effort Defaults | **Affected personas:** BA, Product-Owner, Manager, Developer, Authenticated User
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (5 unresolved)

---

## Feature Summary

**Description:** Today, when a BA starts an Interview, a Developer starts an ADR, or any user starts a Cursor-backed module (PRD, Design Doc, Standup, Feature Request, Agent Home, and the rest), the run always executes at whatever reasoning effort the Cursor SDK defaults to — there is no way for the platform to apply a Project Admin's configured effort, and nothing stops a client from sending its own effort value on the request. This feature makes the server the sole authority: at the moment any module starts, the server resolves that module's configured effort (set up in [`per-module-agent-effort-defaults`](../design-doc-design.md) FEAT-002, not part of this feature) and passes it to the Cursor SDK, silently and without a runtime picker, while discarding any effort value a client attempts to supply. End users see no new control and no behavior change beyond runs quietly matching whatever effort a Project Admin has configured.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-002 | PBI | Automatically run each agent module at its configured effort level | Must Have |
| TBI-005 | TBI | Introduce server-set agentModule identity and effort resolution in the kickoff/config-resolution service | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- Server-side resolution of a module's effort in the order pill/option effort → module override → project default → omit, executed on every kickoff of a Cursor-backed module (Interview, PRD, ADR, Design Doc, Standup, Feature Request, Development, and the rest), and on the Agent Home skill-pill handler.
- A server-set module identifier attached to the kickoff object each calling service constructs, never supplied or overridable by the browser.
- Discarding any client-supplied effort value on a kickoff request, a `SendMessageRequest` turn, or an artifact-create request body (e.g., `POST /api/adr`, `POST /api/interviews`).
- Passing the resolved effort to the Cursor SDK alongside the already-resolved model.
- Treating an unknown or corrupted stored effort value as unset (omitted) rather than failing the run.

**Out of scope:**
- A runtime effort picker for end users at interview start, Agent Home, or any other kickoff surface — defaults are admin-only (Feature-level and PBI-002 both exclude this).
- Setting or changing the per-module effort defaults themselves — that is FEAT-002 (`Admin Per-Module Effort Defaults`), a dependency of this feature, not part of it.
- Snapshotting the resolved effort onto artifact rows or `ai_usage_events`, and rendering it in artifact headers or AI Cost Analytics — that is FEAT-004 (`Effort Snapshot on Audit & Cost History`), which consumes the value this feature resolves but is a separate feature.
- The shared `EffortLevel` union and the `project_skill_settings` / artifact / `ai_usage_events` columns themselves — that is FEAT-001 (`Effort Data Model & Shared Allow-List Foundations`), a dependency this feature builds on.
- Trusting or accepting a client-supplied effort value on kickoff, create, or send-message requests, under any circumstance.

---

## Target Surface

**Primary surface:** Backend only (Express server). The epic as a whole is full-stack (PRD § Target Surface), because FEAT-002 adds an admin UI control and FEAT-004 adds a small artifact/cost-view label — but this feature, FEAT-003, is pure server-side resolution with no new UI surface of its own; see Out-of-Scope.

**Experience notes:** Not applicable — there is no user-visible change. A BA, Product-Owner, Manager, Developer, or Authenticated User starts a module exactly as they do today; the only difference is which reasoning effort silently runs underneath, driven entirely by what a Project Admin already configured (FEAT-002).

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Start a module and have its configured default effort applied | Whoever already starts that module today — BA, Product-Owner, or Manager (Interview); Developer (ADR, Development); Authenticated User (Agent Home chat, Feature Request); and each module's other existing create/run permissions | Project-scoped |

**Feature flag:** `None` — rollout: GA from launch
**Behavior when flag is off:** Not applicable. There is no flag. Until a Project Admin sets a non-null effort for a module (FEAT-002), that module's resolved effort is `undefined` and the Cursor SDK's own default effort applies — identical to today's behavior. No permission changes; no new RBAC key is introduced (see [design-doc-tech-spec.md](design-doc-tech-spec.md) § Security Enforcement).

---

## Acceptance Criteria

### PBI-002 — Automatically run each agent module at its configured effort level

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | A Project Admin has set the Interview module's effort to High | A BA starts a new interview | The interview's agent kickoff is sent to the Cursor SDK with effort High |
| (b) Error/failure | A `project_skill_settings` row has a corrupted or unrecognized effort value from a legacy or manual edit | A module resolves effort for a new run | The unrecognized value is treated as unset, no effort argument is passed, and the run proceeds normally instead of failing |
| (c) Edge case/boundary | A module has no configured effort override and no project default effort set | That module starts a run | No effort argument is passed to the Cursor SDK and the SDK's own default effort applies |
| (d) Negative scenario | A malicious or buggy client sends `effort: "high"` on a kickoff request for a module configured with effort Low | The server processes that kickoff | The client-supplied value is ignored and the module's configured Low effort is used instead |

---

## UI/UX

Not applicable. PBI-002 explicitly excludes a user-visible effort selector at kickoff — resolution is silent and admin-defined, and this feature introduces no new component, route, or interaction state on any surface. The only visible artifacts of the underlying effort feature (the FEAT-002 admin dropdown and the FEAT-004 artifact/cost-history label) belong to sibling features and are out of scope here.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
