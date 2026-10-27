# Design — Zod-Authoritative API Contract

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Data and API Contract Layer | **Affected personas:** Developer, QA
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (4 unresolved)

---

## Feature Summary

**Description:** Teams that build on the full-stack Express starter template today write validation, TypeScript types, and API documentation by hand, and the three drift apart. This Feature gives the template one contracts package where a Developer defines each endpoint once in Zod. Runtime validation, TypeScript types for the API and the web client, and a committed OpenAPI 3.1 document all come from that one definition. A drift check fails when the committed document differs from a fresh generation. QA reads the committed document to plan API tests without starting the application. The Feature changes nothing in Apex's own runtime.

**Parent Feature dependency:** FEAT-001 (Isolated pnpm Workspace and Pinned Toolchain). It needs the workspace and the shared config package.

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-009 | TBI | Create the contracts package with shared Zod route definitions | Must Have |
| TBI-010 | TBI | Generate the OpenAPI 3.1 document and add the drift check | Must Have |
| TBI-011 | TBI | Define error, request ID, pagination, and versioning conventions | Must Have |
| PBI-006 | PBI | Define an endpoint once | Must Have |
| PBI-007 | PBI | Inspect the API contract without running the application | Should Have |

**Developer workflow this Feature delivers:**

1. Add one route definition to the contracts package (method, versioned path, request, responses).
2. Run `openapi:generate` to rewrite the committed OpenAPI document, and commit it with the definition.
3. Run `openapi:check` (also part of the root `check` script) to prove the document matches the definitions.

**Reference routes the Feature defines** (handlers belong to the Health and Self-Service Profile API Feature):

| Operation | Method and path | Success | Declared errors |
|-----------|-----------------|---------|-----------------|
| `getHealthLive` | `GET /health/live` | `200 { status: "ok" }` | `500` |
| `getHealthReady` | `GET /health/ready` | `200 { status: "ready" }` | `503` not ready, `500` |
| `getMe` | `GET /api/v1/me` | `200` profile (`displayName`, `email`, `status`) | `401`, `429`, `500` |
| `putMe` | `PUT /api/v1/me` | `200` updated profile | `400`, `401`, `429`, `500` |

Every response, success or error, carries an `X-Request-Id` header. Every error body is RFC 9457 Problem Details (`application/problem+json`) with a `requestId` member.

---

## Scope and Out-of-Scope

**In scope:**
- A contracts package where each route is one definition holding its method, versioned path, request schemas (params, query, headers, body), response schemas, and error schemas.
- TypeScript types derived from those definitions for the API application and the web client.
- A generated, committed OpenAPI 3.1 document, with a generate command and a drift check that fails on any difference and prints the difference.
- Validation of the committed document as OpenAPI 3.1.
- Shared conventions as reusable definitions: the Problem Details schema and error type catalog, the `X-Request-Id` response header, bounded cursor pagination, and versioned route prefixes.
- A definition-time guard that rejects any request schema naming a user identifier or subject field (BR-001).
- Reference definitions for `GET /health/live`, `GET /health/ready`, `GET /api/v1/me`, and `PUT /api/v1/me`.
- A comparison function that reports routes present in the running API but absent from the contracts (and the reverse), for the API application to call.
- A README section that lists the conventions for new endpoints.

**Out of scope:**
- OpenAPI-first authoring (Feature).
- Manually maintained OpenAPI files, and handwritten OpenAPI edits (Feature, PBI-006).
- Non-JSON payload formats (PBI-006).
- A hosted API documentation site (PBI-007).
- An interactive API explorer (PBI-007).
- User list, user create, user lookup, or full user CRUD endpoints, and any route that accepts a user identifier (PRD out of scope, BR-001).
- Roles, permissions, and RBAC (PRD out of scope, BR-003).
- Express middleware, `registerRoute`, request validation at runtime, and the Express route discovery script (Health and Self-Service Profile API Feature).
- The typed web API client (Self-Service Profile Screen Feature).
- Contract conformance tests that call running routes (Reference Test Framework Feature).
- The quality manifest entry that names the drift gate (Quality Manifest and NFR Manifest Feature).
- The `api-contract` Skill that teaches these rules (Role Skill Set Feature).
- Any change to Apex runtime behavior, its database, or its services.

---

## Target Surface

**Primary surface:** Full-stack (both client and server), per the PRD. This Feature ships only the shared contracts package that both sides import. It adds no screen and no server runtime.

**Experience notes:** The template is a standalone starter repository, not an Apex screen. The Developer experience is a command-line workflow: edit a definition, regenerate, check. QA's experience is reading one plain-text JSON file. Neither has an Apex navigation entry.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Add or change a route definition in the contracts package | Developer, through repository write access in the generated project (no roles defined in the template) | No restriction |
| Run `openapi:generate` and `openapi:check` | Developer, QA (locally, and in any pipeline Platform Engineering adds) | No restriction |
| Read the committed OpenAPI document | Developer, QA, Platform Admin (stand-in for Platform Engineering) through repository read access | No restriction |
| Call `GET /api/v1/me` and `PUT /api/v1/me` (as declared by the contract) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Call `GET /health/live` and `GET /health/ready` (as declared by the contract) | None | No restriction |
| Review the template in Apex and move it to the bootstrap source | Platform Admin (stand-in for Platform Engineering) | Global |

The contract declares whether a route needs an authenticated principal. The API application enforces it (Identity Provider Adapter and Health and Self-Service Profile API Features). The contract names no role or permission, because RBAC is an extension point.

**Feature flag:** `None` — rollout: Not applicable (the PRD sets "Flag required: No")
**Behavior when flag is off:** Not applicable

---

## Acceptance Criteria

### PBI-006 — Define an endpoint once

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | I add a route definition to the contracts package | I regenerate the OpenAPI document | The new route appears with its request, response, and error schemas |
| (b) Error/failure | I add a route definition but do not regenerate the document | I run the drift check | The check fails and shows the missing route |
| (c) Edge case/boundary | A route accepts an optional field with minimum and maximum lengths | I send values at, below, and above the limits | Values at the limits pass and values outside them return a Problem Details validation error |
| (d) Negative scenario | I implement a handler that is not defined in the contracts package | I run the checks | The undocumented route is reported and the check fails |

### PBI-007 — Inspect the API contract without running the application

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | The committed OpenAPI document is current | I open it | It lists every route with request, response, and error schemas and the request ID header |
| (b) Error/failure | The committed document is stale | I run the drift check | The check fails, so I do not rely on an outdated contract |
| (c) Edge case/boundary | A route has no examples | I read its entry | The schema still fully describes valid and invalid inputs |
| (d) Negative scenario | I look through the document examples | I search for real names, emails, or identity subjects | Only clearly synthetic values appear |

### Technical items — definition of done

| Item | Done when |
|------|-----------|
| TBI-009 | Profile read and update routes are defined once with request, response, and error schemas. The API and the web client import types derived from the definitions. Unit tests prove valid and invalid payloads parse as expected. The package builds with no framework or database imports. |
| TBI-010 | A generate command writes the committed document. The drift check exits non-zero and shows the difference when the document is stale. Two runs produce byte-identical output. The committed document validates as OpenAPI 3.1. A route missing from the contracts package cannot appear in the document. |
| TBI-011 | One Problem Details schema covers validation, authentication, not-found, and internal errors, and carries no identity values or stack traces. Every route definition declares the request ID header and its error responses. Pagination defines a default and a maximum page size. A README section lists the conventions for new endpoints. |

---

## UI/UX

Not applicable. This Feature is a shared package and two command-line scripts. It has no routes, screens, components, or `data-testid` attributes. The one reader-facing artifact is the committed OpenAPI document, a plain JSON file that screen readers and agents can read as text.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
