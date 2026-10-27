# Design — Identity Provider Adapter

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Reference API and Platform Services | **Affected personas:** Developer, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Generated applications need a way to know who is calling, but the team has not chosen a production identity provider. This Feature gives developers an authenticated-principal contract, an adapter interface, and an authentication middleware that protects routes. It adds a development adapter that runs every request as one fixed synthetic principal, so developers can build and test authenticated features today. A developer can later plug in the provider that Platform Admin (Platform Engineering) selects without changing any route handler. The template defines no roles, permissions, or authorization policy.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-012 | TBI | Define the principal contract, adapter interface, and authentication middleware | Must Have |
| TBI-013 | TBI | Add the development adapter and the production startup guard | Must Have |
| PBI-008 | PBI | Use protected routes locally without an identity provider | Must Have |
| PBI-009 | PBI | Replace the adapter with the production identity provider | Must Have |

**Depends on:** FEAT-001 (Isolated pnpm Workspace and Pinned Toolchain) and FEAT-004 (Zod-Authoritative API Contract, for the Problem Details error schema). The environment schema from TBI-004 (FEAT-002) is also needed; see the ⚠ item on the missing dependency edge in the assumptions file.

---

## Scope and Out-of-Scope

**In scope:**
- An authenticated-principal contract that carries the external identity subject, with optional display name and optional email (TBI-012).
- An adapter interface that resolves a principal from a request (TBI-012).
- An authentication middleware that rejects unauthenticated requests with an RFC 9457 Problem Details 401 carrying the request ID (TBI-012).
- A test adapter that proves handlers read the principal only from the middleware (TBI-012).
- A development adapter that returns one fixed, clearly synthetic principal (TBI-013).
- A startup guard that aborts the API before it opens a port when the development adapter is selected in production, or when the authentication mode is missing (TBI-013, PBI-008).
- Selection of the adapter through configuration, so a project can swap in a provider adapter with no handler change (PBI-009).
- Adapter documentation that states roles are not defined and names where RBAC would attach (PBI-009).

**Out of scope:**
- Choosing or integrating a production identity provider (Feature).
- Roles, permissions, and authorization policy; role mapping (Feature, PBI-009). RBAC stays an explicit extension point.
- Shipping a specific provider implementation (PBI-009).
- Header-based impersonation and multiple synthetic principals (PBI-008).
- Sign-in screens, sessions, token issuance, and password storage. The identity provider owns identities, and `app_users` holds no passwords or sessions (PRD).
- Changes to Apex runtime behavior, its database, its RBAC, or its authentication (PRD Out of Scope, BR-008).
- A user list, user lookup, or any endpoint that takes another person's identifier (PRD Out of Scope, BR-001).

---

## Target Surface

**Primary surface:** Backend only (Express server). The code lives in the template's API application. The template as a whole is full-stack; this Feature adds no client code.

**Experience notes:** Not applicable. The Feature is a developer workflow. The only text a person reads is the Problem Details 401 body that a client receives, and the startup error that a developer sees in the terminal. Both are plain language and carry no identity values.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Call a protected route (any route under `/api/v1`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Use the development adapter | Local only: authentication mode `development` and non-production environment | User-scoped (one fixed synthetic principal) |
| Check liveness and readiness (`/health/live`, `/health/ready`) | None; these routes sit outside the authentication middleware | No restriction |
| Replace the adapter with a production identity provider | Developer in the consuming project (code change plus configuration); Platform Admin (Platform Engineering) selects the provider | Not applicable |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering | Not applicable |

**Feature flag:** `None` — rollout: Not applicable. The template's own flag-evaluation interface (FEAT-008) is a separate capability and does not gate this Feature.
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-008 — Use protected routes locally without an identity provider

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The authentication mode is `development` and the environment is local | I call a protected route | The request runs as the fixed synthetic principal |
| (b) Error/failure | The environment is production and the authentication mode is `development` | I start the API | Startup aborts with an error and no port opens |
| (c) Edge case/boundary | The authentication mode is not set | I start the API | Startup aborts naming the missing setting and never falls back to the development adapter |
| (d) Negative scenario | No adapter authenticates the request | I call a protected route | I receive a Problem Details 401 response |

### PBI-009 — Replace the adapter with the production identity provider

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I implement the adapter interface for a provider | I select it through configuration | Protected routes resolve the principal from the provider with no handler changes |
| (b) Error/failure | The provider rejects or cannot verify credentials | I call a protected route | I receive a Problem Details 401 response and no identity values are logged |
| (c) Edge case/boundary | The provider returns a principal with no email | The principal reaches a handler | The handler works because only the external subject is required |
| (d) Negative scenario | I read the adapter documentation | I look for role or permission guidance | It states that roles are not defined and describes where RBAC would attach |

**Technical work items.** TBI-012 and TBI-013 carry no acceptance criteria of their own. Their definitions of done are verified through the rows above and through VT-01 to VT-15 in the technical specification: the principal contract has no role or permission field (VT-02), unauthenticated requests get a Problem Details 401 (VT-03), handlers read the principal only from the middleware (VT-04), the development adapter returns a fixed synthetic principal (VT-10, VT-11), and every combination of authentication mode and environment is covered (VT-08, VT-09).

---

## UI/UX

Not applicable. This Feature is backend-only and adds no route, screen, component, or `data-testid`.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
