# Design — Health and Self-Service Profile API

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Reference API and Platform Services | **Affected personas:** Authenticated User, Platform Admin
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (3 unresolved)

---

## Feature Summary

**Description:** The starter template needs a working backend that a new project can run on day one. This Feature adds the reference endpoints of the Express 5 API: an Authenticated User reads and updates their own profile through `GET` and `PUT /api/v1/me`, and a Platform Admin (stand-in for Platform Engineering) checks whether a deployed instance is alive and ready through `GET /health/live` and `GET /health/ready`. The end state is an API in which a person can reach only their own profile, every error is an RFC 9457 Problem Details response with a request ID, and the health endpoints tell an orchestrator the real state of an instance without exposing any detail.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| PBI-010 | PBI | Retrieve my own profile | Must Have |
| PBI-011 | PBI | Update my own profile | Must Have |
| PBI-012 | PBI | Check liveness and readiness of a running instance | Must Have |
| TBI-014 | TBI | Build the Express composition root and error handling | Must Have |
| TBI-015 | TBI | Implement the profile service and routes | Must Have |

**Depends on:** FEAT-003 (Starter Persistence with `app_users`), FEAT-004 (Zod-Authoritative API Contract), FEAT-005 (Identity Provider Adapter), FEAT-007 (Observability and Graceful Shutdown).

---

## Scope and Out-of-Scope

**In scope:**
- `GET /api/v1/me` returns the authenticated principal's own profile (display name, optional email, status) and creates the profile on first authenticated access (PBI-010, TBI-015).
- `PUT /api/v1/me` validates and updates the principal's own display name and email (PBI-011, TBI-015).
- `GET /health/live` reports process liveness with no authentication and no database call (PBI-012).
- `GET /health/ready` reports database readiness within a time limit, with no authentication and no sensitive detail (PBI-012).
- The Express 5 composition root: request ID on every response, structured logging hook-up, authentication on versioned routes, a central error handler that returns Problem Details, a not-found handler, rate-limit hooks set by environment, and static serving of the built web client when present (TBI-014).
- Problem Details bodies for validation, authentication, not-found, unavailable, and internal errors, each with the request ID (BR-005).
- Scoping by construction: the subject comes from the authenticated principal only, and no route accepts a user identifier (BR-001).

**Out of scope:**
- User list, create, lookup, and full CRUD endpoints (Feature).
- Cross-user access of any kind (Feature).
- Retrieving another person's profile, and listing profiles (PBI-010).
- Changing the external identity subject or `status`, and updating another person's profile (PBI-011).
- Detailed dependency diagnostics, and authenticated admin status pages (PBI-012).
- Roles, permissions, and RBAC. The template defines none; Platform Engineering decides later (BR-003).
- A production identity provider. FEAT-005 ships the adapter interface and the development adapter.
- Data classification of display name, email, and subject (Platform Engineering).
- The profile screen. FEAT-010 builds it on this API.
- Production execution of migrations, CI pipelines, and AWS or ECS configuration (Platform Engineering).
- Any change to Apex runtime behavior, its database, or its services.

---

## Target Surface

**Primary surface:** Backend only (Express server)

**Experience notes:** This Feature has no screen. The backlog `route` value `/profile/details/edit` is a label, not a page. The profile screen in FEAT-010 consumes these endpoints through the generated typed client. That screen needs three things from this API: error bodies with plain-language, field-level messages (it shows them as field errors); a 401 it can turn into a "sign in" state; and a 503 it can turn into a retry state. The API gives all three. Apex gets no navigation entry for the template.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Read own profile (`GET /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Update own profile (`PUT /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Check liveness and readiness (`/health/live`, `/health/ready`) | No authentication. Callers are the Platform Admin persona and orchestrators | No restriction |
| Use the development identity adapter (decides which principal calls `/api/v1/me` locally) | Local only: authentication mode `development` and a non-production environment | User-scoped (one fixed synthetic principal) |
| Role-based authorization in generated apps | Not defined; an extension point for Platform Engineering | Not applicable |

**Feature flag:** `None` — rollout: None (the PRD marks "Flag required: No")
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-010 — Retrieve my own profile

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am authenticated and my profile exists | I send `GET /api/v1/me` | I receive 200 with my display name, optional email (a string or `null`), and status in the documented response shape. The response has an `X-Request-Id` header and omits the external subject and internal ID. |
| (b) Error/failure | I am authenticated and the database is unavailable | I send `GET /api/v1/me` | I receive a 503 Problem Details response with a request ID (header and `requestId` member). The body holds no connection string, host, driver message, or stack trace. |
| (c) Edge case/boundary | I am authenticated for the first time and have no profile yet | I send `GET /api/v1/me` | A profile is created from my principal's subject and display name (no email, default status) and returned with 200. A repeat request returns the same profile. Two simultaneous first requests still create one row. |
| (d) Negative scenario | I am not authenticated, or I add another person's identifier to the request (query string, header, or extra path segment) | I send a request for a profile | An unauthenticated request receives a Problem Details 401. An added identifier has no effect: I still receive my own profile, or a 404 for a path that does not exist. |

### PBI-011 — Update my own profile

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I am authenticated | I send `PUT /api/v1/me` with a valid display name and email | I receive 200 with my updated profile. A later `GET` returns the same values. |
| (b) Error/failure | I am authenticated | I send an empty display name or a malformed email, or the database is unavailable | An invalid value returns a 400 Problem Details response whose `errors` list names each invalid field in plain language, and nothing changes. The response does not repeat what I sent. An unavailable database returns 503 and nothing changes. |
| (c) Edge case/boundary | My profile has an email | I send the update with the email cleared (`null` or blank), or with values at the maximum length (display name 100 characters, email 254) | The cleared email is accepted and stored as no email. Values at the limit are saved. Values over the limit return 400. |
| (d) Negative scenario | I am authenticated, or I am not | I include a `subject`, `id`, or `status` field in the update, or I send the update with no credentials | The extra field returns 400 naming that field, and only my own display name and email can change. An unauthenticated update returns a Problem Details 401. |

### PBI-012 — Check liveness and readiness of a running instance

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The process is running and the database is reachable | I request `/health/live` and `/health/ready` | Both return 200 with a request ID. Liveness makes no database call. |
| (b) Error/failure | The database is unreachable | I request `/health/ready` | It returns 503 (not ready) with no connection string, host, or error text. `/health/live` still returns 200. |
| (c) Edge case/boundary | The database check takes longer than its time limit (default 2 seconds) | I request `/health/ready` | It returns 503 within the limit plus a small margin instead of hanging. |
| (d) Negative scenario | I send no credentials | I request either health endpoint | I receive the health response, never a 401. |

---

## UI/UX

Not applicable. This Feature is backend only. The profile screen that calls these endpoints belongs to FEAT-010 (PBI-019, PBI-020).

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
