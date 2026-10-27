# Technical Specification — Health and Self-Service Profile API

> **PRD slug:** `full-stack-express-starter-template` | **Owning layer:** `templates/full-stack-express/apps/api/` and `templates/full-stack-express/packages/contracts/` (Apex's own layers untouched) | **Surface:** Backend only
> **Verification builds:** From `templates/full-stack-express/`: `pnpm build`, `pnpm check`, `pnpm test`. Apex isolation check from the repo root, which must pass unchanged: `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`.
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (3 unresolved)
> **Design doc:** [design-doc-design.md](design-doc-design.md)

---

## System Boundary and Owning Layer

**Owning layer:** The template's API application (`templates/full-stack-express/apps/api/`) and its contracts package (`templates/full-stack-express/packages/contracts/`). Apex's own layers (`src/server/services/`, `src/server/routes/`, `src/client/components/`, `src/shared/types/`, `migrations/`) are not touched.

**Rationale:** The PRD builds the template as a nested, self-contained sample with its own lockfile and scripts (BR-008). It is not part of Apex's workspace or runtime. The Feature therefore lives in the template's API app. The route definitions live in the contracts package because Zod is the single authority for validation, types, and OpenAPI (BR-004). The layer names mirror Apex's BFF layout from the `fullstack-node-bff` skill (routes, services, middleware), so an agent that knows Apex finds the same shape in the template. The template folder paths are proposed here. TBI-001 fixes them (see assumptions).

**Ownership answers:**
- New or existing Express service in `src/server/services/`? **No** for Apex: nothing changes in Apex. In the template, a **new** `apps/api/src/services/profileService.ts` (modelled on Apex's `profileService.ts`) and `apps/api/src/services/readinessService.ts`.
- New or existing route in `src/server/routes/`? **No** for Apex. In the template, **new** `apps/api/src/routes/me.ts` (`GET`/`PUT /me` under `/api/v1`) and `apps/api/src/routes/health.ts`. Apex's closest prior art is `src/server/routes/profile.ts` (self-scoped, thin adapter over a service) and the `/api/health/*` routes in `src/server/routes/api.ts`.
- New React component in `src/client/components/`? **No.** The Feature has no UI. FEAT-010 builds the profile screen.
- New shared type in `src/shared/types/`? **No** for Apex. In the template, the shared shapes are Zod definitions in the contracts package (`packages/contracts/src/routes/me.ts`, `health.ts`), and TypeScript types derive from them. Apex's `src/shared/types/profile.ts` is the prior art for strict request parsing.
- Database migration needed? **No.** This Feature adds no table or column. It reads and writes `app_users`, which FEAT-003 creates in the initial migration (TBI-007). The migration must be applied before the API serves traffic.

---

## Security Enforcement

- **Authorization mechanism:** Authentication only. No roles, permissions, or authorization policy exist in the template (BR-003). `app.use('/api/v1', authenticate, v1Router)` puts every route under `/api/v1` behind the FEAT-005 authentication middleware, the same mount shape as `app.use('/api/my-feature', ensureAuthenticated, routes)` in the `fullstack-node-bff` skill. The middleware returns a Problem Details 401 when the adapter cannot resolve a principal. Health routes mount before it and need no credentials. **Apex RBAC:** `rbac-governance.mdc` applies to Apex UI. This Feature adds no permission key, `can()` guard, `requirePermission` call, or catalog change, and does not load the `rbac-management` skill. If Platform Engineering adds roles later, the extension point is one more middleware after `authenticate` on the `/api/v1` mount (the role Apex's `requirePermission` plays). Handlers stay unchanged.
- **Layer that enforces scope:** Both.
  - *Route middleware:* `authenticate` sets the principal. Handlers read it through one helper, `getPrincipal(req)`, and never read the subject from `req.params`, `req.query`, `req.body`, or any header. The helper throws if no principal is set, which is a wiring bug and returns 500.
  - *Service layer:* scope holds by construction. `getOrCreateOwnProfile(principal)` and `updateOwnProfile(principal, input)` take a principal and no identifier. The data-access calls are keyed by `principal.subject`. No service or data-access function in this Feature takes a user ID from the request. No route registers a `:id` parameter. This follows the self-scoping comments in Apex's `src/server/routes/profile.ts`: "the actor is always the authenticated subjectOid".
  - *Contract:* the `PUT` body schema is strict, so `subject`, `externalSubject`, `id`, and `status` return 400 instead of reaching the service.
- **Sensitive data handling:** Display name, email, and the external subject are identity values (BR-007). Their data classification is unresolved and belongs to Platform Engineering (PRD). Rules for this Feature:
  - The `GET`/`PUT` response omits the subject and the internal UUID.
  - Problem Details bodies name invalid fields but never repeat submitted values, and never include stack traces, SQL, hosts, or connection strings. The central error handler builds 500 and 503 bodies from fixed text.
  - Logs and span attributes never contain identity values. Redaction hooks come from TBI-016 (FEAT-007). This Feature adds a test (VT-29) that proves it for every flow here. Apex precedent: `console.error('[profile] unexpected error')` with no personal content.
  - `/api/v1/me` and the health routes send `Cache-Control: no-store`.
  - Health responses expose only a fixed status and the request ID.

---

## Architecture and Approach

### Layers touched

| Layer | Changed | Notes |
|-------|---------|-------|
| Server services (`src/server/services/`) | No | Apex untouched (BR-008). |
| Server routes (`src/server/routes/`) | No | Apex untouched. |
| Server middleware (`src/server/middleware/`) | No | Apex untouched. |
| Client components (`src/client/components/`) | No | No UI in this Feature. |
| Client hooks (`src/client/hooks/`) | No | FEAT-010 owns the profile hook. |
| Shared types (`src/shared/types/`) | No | Apex untouched. |
| Database (migrations/) | No | Apex untouched. The template's `app_users` migration is FEAT-003. |
| Drizzle schema (`src/server/db/schema.ts`) | No | Apex untouched. The template's schema is FEAT-003. |
| Template API app (`templates/full-stack-express/apps/api/src/`) | Yes | `app.ts` (`createApp(deps)`), `middleware/requestId.ts`, `middleware/errorHandler.ts`, `middleware/notFound.ts`, `middleware/rateLimit.ts`, `routes/me.ts`, `routes/health.ts`, `services/profileService.ts`, `services/readinessService.ts`, static client serving. |
| Template contracts package (`templates/full-stack-express/packages/contracts/src/`) | Yes | New `routes/health.ts`. Check and complete `routes/me.ts` (owned by TBI-009). Regenerate the committed OpenAPI document. |
| Template data-access module (FEAT-003) | Yes (small) | Add `ping()` and confirm typed errors (see Cross-Feature requirements). |
| Template identity module (FEAT-005) | Yes (small) | Optional `displayName` on the principal contract (⚠ in assumptions). |

### Cross-Feature requirements

This Feature depends on four other Features. It needs these exact things from them:

| Owner | Requirement | Why |
|-------|-------------|-----|
| FEAT-004 (TBI-009, TBI-011) | `me` route definitions match the shapes in Data and Contracts, including the strict body, limits, and Problem Details responses `400/401/500/503` on each route. Health definitions declare no security. | Handlers and tests derive from these definitions (BR-004). |
| FEAT-003 (TBI-006) | `findBySubject`, `create`, `update` as listed. Add `ping(): Promise<void>` (runs `select 1` through the Drizzle `sql` tag, as `postgresql-db.mdc` advises for health checks). Throw `DataAccessUnavailableError` for connection-class failures and `UniqueViolationError` for subject conflicts. Column widths at least 100 (`display_name`) and 254 (`email`). The pool's connection timeout must not exceed the readiness limit, so an abandoned ping releases its slot. | Readiness, 503 mapping, first-access race, field limits. |
| FEAT-005 (TBI-012) | `Principal` carries `subject` and an optional `displayName`. `authenticate` sets the principal for handlers and returns Problem Details 401 through the shared error handler. | PBI-010 (c) creates the profile from the principal. |
| FEAT-007 (TBI-016) | A logger that handlers and middleware receive through `createApp(deps)`, with redaction for display name, email, and subject. | BR-007. |

### Per-work-item design decisions

**TBI-014 — Build the Express composition root and error handling**
- Pattern followed: Apex's BFF composition in `src/server/index.ts` (routers mounted with auth, static serving after `/api/*`, SPA fallback last), per the `fullstack-node-bff` skill. The template uses a `createApp(deps)` factory instead of a module-level app, so tests inject fakes for data-access, the identity adapter, and the logger. `server.ts` builds the real dependencies and calls `listen`.
- Key decisions:
  - **Middleware order:** `requestId` → request logging (health paths at debug level) → health router → rate-limit hook (skips health) → `/api/v1` router (`express.json({ limit: '16kb' })` → `authenticate` → `me` router) → `/api/*` not-found (Problem Details) → built client static files and SPA fallback when the client build directory is configured and present → global not-found → error handler. Request ID comes first so a 401 carries one. The `/api/*` not-found sits before the SPA fallback so an unknown API path never returns `index.html` (the same rule the `fullstack-node-bff` skill states).
  - **Express 5:** async handlers that reject reach the error handler without a wrapper library. Wildcard routes use the Express 5 syntax (`/{*splat}`), not `*`.
  - **Error handler:** one function maps errors to Problem Details: request validation error → 400 with `errors[]` (`field`, `message`; no input echo); `AuthenticationError` → 401; body-parser parse failure → 400; body too large → 413; `DataAccessUnavailableError` → 503; rate-limit hook → 429; anything else → 500 with fixed text. It sets `Content-Type: application/problem+json` and the `requestId` member (same value as the header). It logs the error once, redacted, with the request ID.
  - **Rate-limit hook:** a middleware slot that reads limit settings from validated config and does nothing when unset. The template ships no vendor limiter. Rejected alternative: a built-in default limit, because the PRD asks for hooks "configurable by environment" and the NFR targets belong to each project.
  - **Client serving:** `express.static` over the build directory with `index.html` as no-cache, as in the `fullstack-node-bff` skill. Absent directory means no static handler (API-only runs).

**TBI-015 — Implement the profile service and routes**
- Pattern followed: Apex's `src/server/routes/profile.ts` (thin route over `profileService`, strict parse of the body, typed service errors mapped in one place) and `src/shared/types/profile.ts` (`parseUpdateCurrentProfileRequest` rejects unknown and identity fields).
- Key decisions:
  - **Routes:** `me.ts` registers `GET /me` and `PUT /me` from the shared definitions. Each handler parses the request with the contract schema, calls the service with `getPrincipal(req)`, and returns the result parsed through the response schema (so a handler cannot leak a field the contract omits).
  - **`ensureProfile(principal)`:** `findBySubject(subject)`; if null, `create({ subject, displayName: principal.displayName?.trim() || 'User' })`; on `UniqueViolationError` read the row again once and return it; a second miss throws. `GET` calls it and maps the row to `ProfileResponse`. `PUT` calls it, then `update(subject, { displayName, email })` (⚠ default in assumptions).
  - **Normalization:** `displayName` is trimmed. `email` is trimmed, and blank or omitted becomes `null`. The schema carries this, so the OpenAPI document and the code agree.
  - **Rejected alternative:** an upsert (`on conflict do nothing`) inside `create`. TBI-006 defines `create` as a plain insert with a typed conflict error, and the retry keeps the data-access interface small.
  - **Principal only from middleware:** a test adapter in VT-07 proves handlers read nothing else (TBI-012 DoD).

**PBI-010 — Retrieve my own profile**
- Pattern followed: Apex `GET /api/profile/current` (`getCurrentProfile(subjectOid, claimIdentity(req))`: read, create on first access, return).
- Key decisions: Returns `ProfileResponse` (`displayName`, `email | null`, `status`). Ignores unknown query parameters and headers; a path with an extra segment is a 404 because no `:id` route exists. Deviation from Apex: Problem Details bodies instead of `{ error: string }` (BR-005).

**PBI-011 — Update my own profile**
- Pattern followed: Apex `PUT /api/profile/current` (strict body parse, 400 on bad input, 200 with the full updated profile).
- Key decisions: Full replacement of the two editable fields, so the response always shows the stored state. Strict schema rejects `subject`, `externalSubject`, `id`, `status`, and any other key with a 400 that names it. The update runs in one statement; there is no read-modify-write window to guard.

**PBI-012 — Check liveness and readiness of a running instance**
- Pattern followed: Apex `/api/health/live` (process only) and `/api/health/ready` (database, 200 or 503), tested in `src/server/__tests__/healthDb.test.ts`.
- Key decisions:
  - `readinessService.check()` races `dataAccess.ping()` against a timer set by `READINESS_TIMEOUT_MS` (default 2000). It clears the timer when the ping settles. It returns `ready` or throws `NotReadyError`, which the error handler turns into the 503 Problem Details (`not-ready`, fixed detail text; ⚠ in assumptions).
  - Liveness handler has no dependencies: it returns `{ "status": "ok" }`. Its test builds the app with a data-access fake whose every method throws.
  - Readiness checks connectivity only, not schema (assumptions).
  - Deviation from Apex: Apex returns `{ healthy, error }`; the template uses the shared Problem Details shape and has a deadline Apex lacks.

---

## Data and Contracts

### API endpoints

All responses carry `X-Request-Id`. Every non-2xx response is `application/problem+json` with `type`, `title`, `status`, `detail`, `requestId`, and (for 400) `errors: [{ field, message }]`. The `type` identifiers come from TBI-011 (`validation-error`, `unauthenticated`, `not-found`, `service-unavailable`, `internal-error`, `not-ready`, `rate-limited`, `payload-too-large`).

| Method | Route | Request shape | Response shape | Auth |
|--------|-------|--------------|----------------|------|
| GET | `/health/live` | None | 200 `{ "status": "ok" }` | None |
| GET | `/health/ready` | None | 200 `{ "status": "ready" }`; 503 Problem Details `not-ready` | None |
| GET | `/api/v1/me` | No parameters. Unknown query parameters and headers are ignored. | 200 `ProfileResponse`; 401, 429, 500, 503 Problem Details | `authenticate` (principal required; no roles) |
| PUT | `/api/v1/me` | `UpdateProfileRequest` (strict JSON object) | 200 `ProfileResponse`; 400, 401, 413, 429, 500, 503 Problem Details | `authenticate` (principal required; no roles) |

Shapes (Zod authority in `packages/contracts`; TypeScript types derive from them):

```ts
// ProfileResponse
{ displayName: string; email: string | null; status: ProfileStatus }

// UpdateProfileRequest — .strict(): any other key returns 400 naming that key
{
  displayName: string;       // trimmed, 1..100 Unicode code points
  email?: string | null;     // trimmed, valid address, <= 254 characters; omitted, null, or blank stores no email
}
```

`ProfileStatus` is the value set FEAT-003 defines for `app_users.status`. The contracts package owns the enum and the Drizzle schema reads it, so the two cannot differ. Example values in the OpenAPI document are clearly synthetic (PBI-007 AC).

### Schema / storage changes

| Target | Change | Reason |
|--------|--------|--------|
| `app_users` | None in this Feature. Reads and writes the table FEAT-003 creates. Rows appear on first authenticated access (`ensureProfile`). | Column widths must fit the contract limits (see Cross-Feature requirements). |
| Data-access module interface | Add `ping()`. Confirm typed `DataAccessUnavailableError` and `UniqueViolationError`. | Readiness check, 503 mapping, first-access race. |
| `packages/contracts` OpenAPI document | Add health operations and complete the `me` operations, then regenerate and commit. | The drift check fails on any mismatch (BR-004). |

---

## Testing Strategy

**Unit tests:**
- `profileService` (Vitest, fake data-access): `ensureProfile` returns an existing row; creates on null; retries once on `UniqueViolationError` and returns the winner's row; throws on a second miss; falls back to `User` when the principal has no display name; passes only `principal.subject` to data-access (VT-30).
- `readinessService`: resolves when `ping` resolves; throws `NotReadyError` when `ping` rejects; throws at the deadline when `ping` never settles, using fake timers (VT-19).
- Contract schemas (owned by TBI-009 tests; this Feature adds cases): `UpdateProfileRequest` accepts 100/254-character boundaries and rejects 101/255, rejects unknown keys, normalizes blank email.
- Error handler: each error class maps to the status, `type`, and fixed text above; no input echo; no stack.

**Integration tests:**
- Profile API and health endpoints against real PostgreSQL through Testcontainers (Vitest + Supertest, `createApp` with the real data-access module and the test identity adapter): create-on-first-read, concurrent first access, update, clear email, boundaries, validation failure, unauthenticated access, two-principal isolation, readiness up and down (VT-01, VT-03, VT-04, VT-06 to VT-08, VT-11, VT-12, VT-14, VT-16, VT-18).
- API-level tests with fakes for failure paths that are slow or flaky with a real database: database unavailable, hung ping, wiring order (VT-02, VT-05, VT-09, VT-10, VT-13, VT-15, VT-17, VT-19 to VT-27).
- Route registry and OpenAPI drift check (VT-28). Log capture check (VT-29).
- Prior art: `src/server/__tests__/healthDb.test.ts` (Supertest against a mounted router, 200 and 503 cases, no leak of the database error text). The template swaps the mocked Drizzle for fakes and Testcontainers, per the PRD's testing decisions.
- Coverage floors: 80% lines, functions, statements; 75% branches (BR-012).

**E2E tests (if applicable):**
- None in this Feature. The Playwright profile journey with axe checks belongs to the web client and testing Features and uses these endpoints through the dev adapter.

---

## Observability

- **Custom events/metrics:** One log event, `profile.created`, at info level with the request ID only and no identity values. No custom metrics. HTTP and database spans and metrics come from TBI-017 (FEAT-007); the route label is the template path (`/api/v1/me`), never a value from the request. Health requests log at debug level so probes do not fill the info log.
- **Alerts:** None. Platform Engineering wires probes and alerts to `/health/live` and `/health/ready`. The handoff document must say that the probe timeout has to exceed `READINESS_TIMEOUT_MS`.

---

## Rollback and Deployment

- **Schema changes backward compatible:** Yes. This Feature changes no schema. It needs the FEAT-003 migration applied first. Readiness does not check the schema, so an instance deployed before its migration reports ready and returns 500 on `/api/v1/me` (assumptions). The runbook must say "migrate, then deploy".
- **Rollback procedure:** Redeploy the previous build. Profile rows created on first access stay valid for the older build. API changes are additive within `/api/v1`; a breaking change needs `/api/v2`. Production database rollback is forward-only (BR-006), and this Feature has none to roll back.
- **Deployment dependencies:** None for Apex, because the template does not deploy through Apex. Platform Engineering runs migrations, sets `READINESS_TIMEOUT_MS` and the probe timeouts, and attaches the exporters.
- **Feature flag gates deployment:** No. The PRD marks "Flag required: No", and the template's own flag interface is not used here.

---

## Verification Test Matrix

| ID | Layer | Arrange | Act | Assert | Linked |
|----|-------|---------|-----|--------|--------|
| VT-01 | Integration (Vitest, Supertest, Testcontainers) | Real PostgreSQL. Row exists for synthetic principal A. | `GET /api/v1/me` as A | 200. Body parses with `ProfileResponse`. It has `displayName`, `email`, `status` and no `subject` or `id` key. `X-Request-Id` and `Cache-Control: no-store` present. | PBI-010 (a), TBI-015 |
| VT-02 | API (Supertest, fake data-access) | `findBySubject` rejects with `DataAccessUnavailableError` whose message holds `postgres://synthetic-user:synthetic-pw@db.internal:5432/app`. | `GET /api/v1/me` | 503 `application/problem+json`. `requestId` equals the header. Body has none of `postgres`, `db.internal`, `synthetic-pw`, a stack frame. | PBI-010 (b) |
| VT-03 | Integration | Real PostgreSQL. No row for principal A. | `GET /api/v1/me` twice | Both 200 and equal. One row exists with A's subject and display name, no email, default status. | PBI-010 (c) |
| VT-04 | Integration | Empty table. | 10 parallel first `GET /api/v1/me` as A | All 200 and equal. Exactly one row exists. | PBI-010 (c) |
| VT-05 | API (fake data-access spy) | Adapter returns no principal. | `GET` and `PUT /api/v1/me` with no credentials | 401 Problem Details (`unauthenticated`) with `requestId`. Data-access spy has zero calls. | PBI-010 (d), PBI-011 (d) |
| VT-06 | Integration | Rows for A and B. | As A: `GET /api/v1/me?id=<B-uuid>&subject=<B-subject>` with header `X-User-Id: <B-subject>`; then `GET /api/v1/me/<B-uuid>` | First call returns A's profile and nothing of B's. Second call returns 404 Problem Details. | PBI-010 (d) |
| VT-07 | Integration | Rows for A and B. Test adapter returns A or B by test control. | Read and update as each | Each principal sees only its own values. An update as A leaves B's row unchanged. | PBI-010 (d), PBI-011 (d), TBI-015 |
| VT-08 | Integration | Row for A. | `PUT /api/v1/me` with a valid display name and email, then `GET` | 200 with the new values. `GET` matches. Row `updated_at` moved forward. | PBI-011 (a) |
| VT-09 | API | Authenticated A. | `PUT` with `displayName: ""` and `email: "not-an-email"` | 400 Problem Details. `errors` names `displayName` and `email`. Stored row unchanged. Response body contains neither submitted value. | PBI-011 (b) |
| VT-10 | API (fake data-access) | `update` rejects with `DataAccessUnavailableError`. | `PUT` with valid values | 503 Problem Details with no database detail. Fake shows no successful write. | PBI-011 (b) |
| VT-11 | Integration | Row for A with an email. | `PUT` with `email: null`; then with `"   "`; then with the key omitted | Each returns 200 with `email: null`. Row stores no email. | PBI-011 (c) |
| VT-12 | Integration | Row for A. | `PUT` display name of 100 code points (include a 4-byte emoji); 101; email of 254 characters; 255 | 100 and 254 return 200 and are stored. 101 and 255 return 400 naming the field. | PBI-011 (c) |
| VT-13 | API | Authenticated A. | `PUT` with each extra key (`subject`, `externalSubject`, `id`, `status`) plus a valid body; then an array body and a non-object body | Each returns 400 naming the key (or a body error). Subject and status in the row unchanged. | PBI-011 (d) |
| VT-14 | Integration (⚠ default) | No row for A. | `PUT` with valid values | 200 with the new values. One row exists. | PBI-011 (c), TBI-015 |
| VT-15 | API | Data-access fake whose every method throws. | `GET /health/live` | 200 `{ "status": "ok" }`. Fake has zero calls. | PBI-012 (a) |
| VT-16 | Integration | Real PostgreSQL up. | `GET /health/live` and `/health/ready` with no `Authorization` header | Both 200. Bodies parse with the health schemas. Both carry `X-Request-Id` and `Cache-Control: no-store`. | PBI-012 (a) |
| VT-17 | API | `ping` rejects with a message holding a synthetic connection string. | `GET /health/ready`, then `GET /health/live` | Ready returns 503 (`not-ready`), body holds no connection string, host, or error text. Live returns 200. | PBI-012 (b) |
| VT-18 | Integration | Real PostgreSQL container. | Stop the container; request ready; start it; request ready | 503 while stopped, then 200 after it is back. | PBI-012 (b) |
| VT-19 | API | `ping` never settles. `READINESS_TIMEOUT_MS=50`. | `GET /health/ready` | 503 within 500 ms. The timer is cleared (no open handle). | PBI-012 (c) |
| VT-20 | API | Identity adapter rejects every request. | `GET /health/live` and `/health/ready` | Neither returns 401. | PBI-012 (d) |
| VT-21 | API | App with no client build directory. | `GET /api/v1/unknown` and `GET /unknown` | Both 404 Problem Details with `requestId`. | TBI-014 |
| VT-22 | API | Test-only route throws an error whose message holds a synthetic email. Log capture on. | Request that route | 500 Problem Details with fixed text. Body and captured logs contain neither the email nor a stack frame. | TBI-014 |
| VT-23 | API | One request per status: 200, 400, 401, 404, 413, 500, 503, and both health routes. | Send them | Each response has `X-Request-Id`. Each Problem Details `requestId` equals its header. | TBI-014 |
| VT-24 | API | Spies on `requestId`, `authenticate`, and the `me` handler. | `GET /api/v1/me` with and without a principal; `GET /health/ready` | Order is request ID, authenticate, handler. The 401 carries a request ID. Health runs without `authenticate`. | TBI-014 |
| VT-25 | API | Rate limit set to 2 per window through config. Second app with it unset. | Three requests to `/api/v1/me`; three to `/health/live` | Third `/api/v1/me` returns 429 Problem Details. Health never returns 429. With the setting unset, nothing is limited. | TBI-014 |
| VT-26 | API | Client build directory set to a fixture with `index.html`. Second app with it unset. | `GET /`, `GET /profile`, `GET /api/v1/unknown` | First two return `index.html`. The API path returns 404 Problem Details, not `index.html`. With no directory, `GET /` returns 404 Problem Details. | TBI-014 |
| VT-27 | API | Authenticated A. | `PUT` with malformed JSON; `PUT` with a 20 KB body | 400 and 413 Problem Details (not Express's default HTML page). | TBI-014, PBI-011 (b) |
| VT-28 | Contract / route registry | Built app and committed OpenAPI document. | List registered routes; run the drift check | Every registered route has a contracts definition. The document lists exactly the four operations and the drift check exits 0. | TBI-015, TBI-014 |
| VT-29 | Integration (log capture) | Synthetic subject, display name, and email. Pino output and span attributes captured. | Run the VT-01, VT-03, VT-08, VT-09, VT-13 flows | No captured log line or span attribute contains the subject, display name, or email. | TBI-015, PBI-010 (a), PBI-011 (b) |
| VT-30 | Unit (Vitest, fake data-access) | Fake with scripted results. | `ensureProfile` for: row found; no row; unique conflict then row; two conflicts; principal without display name | Results as listed in Testing Strategy. Only `principal.subject` reaches the fake. | TBI-015, PBI-010 (c) |

---

## Implementation Plan

Prerequisites from other Features: FEAT-004 (TBI-009, TBI-010, TBI-011), FEAT-003 (TBI-006), FEAT-005 (TBI-012), FEAT-007 (TBI-016). S3 may start with test doubles for FEAT-005 and FEAT-007.

- [ ] S1 — Contracts: add `health` route definitions; check `me` definitions against Data and Contracts (strict body, limits, error responses); regenerate and commit the OpenAPI document _(blocked by FEAT-004 TBI-009, TBI-010, TBI-011)_
  - Covers: `VT-28`
- [ ] S2 — Data-access: add `ping()`, confirm `DataAccessUnavailableError` and `UniqueViolationError`, confirm column widths; add optional `displayName` to the principal contract _(blocked by FEAT-003 TBI-006 and FEAT-005 TBI-012; can parallel with S1)_
  - Covers: `VT-30` (fakes use these types)
- [ ] S3 — Composition root (TBI-014): `createApp(deps)`, request ID, middleware order, error handler, not-found handlers, rate-limit hook, static client serving _(blocked by S1; uses FEAT-005 and FEAT-007 interfaces)_
  - Covers: `VT-21`, `VT-22`, `VT-23`, `VT-24`, `VT-25`, `VT-26`, `VT-27`
- [ ] S4 — Health routes and `readinessService` (PBI-012) _(blocked by S2, S3; can parallel with S5)_
  - Covers: `VT-15`, `VT-16`, `VT-17`, `VT-18`, `VT-19`, `VT-20`
- [ ] S5 — Profile service and `me` routes (TBI-015, PBI-010, PBI-011) _(blocked by S1, S2, S3; can parallel with S4)_
  - Covers: `VT-01` to `VT-14`, `VT-30`
- [ ] S6 — Cross-cutting checks: route registry and drift check in `pnpm check`, log capture test, coverage floors _(blocked by S4, S5)_
  - Covers: `VT-28`, `VT-29`
- [ ] S7 — Document the endpoints, the probe contract (`READINESS_TIMEOUT_MS`, probe timeout rule, "migrate, then deploy") in the template's API docs and handoff inputs _(blocked by S4, S5; can parallel with S6)_

**Execution lanes:**
- Lane 1 (start when prerequisites land): S1, S2
- Lane 2 (after S1): S3
- Lane 3 (after S2 + S3): S4, S5 in parallel (S5 also needs S1)
- Lane 4 (after S4 + S5): S6, S7 in parallel

---

## Diagram 1 — Code Execution Flow

The primary runtime path is PBI-010: the profile screen (FEAT-010) loads the caller's own profile.

```mermaid
sequenceDiagram
  actor User
  participant Screen as Profile screen FEAT-010
  participant Hook as useProfile hook
  participant Client as Typed API client
  participant Express as Express app
  participant Auth as authenticate middleware
  participant Route as GET me route
  participant Service as profileService
  participant Data as Data-access module
  participant Database as PostgreSQL

  User->>Screen: open profile screen
  Screen->>Hook: useQuery for profile
  Hook->>Client: getMe()
  Client->>Express: GET /api/v1/me
  Express->>Express: assign request ID, start request log
  Express->>Auth: authenticate(req)
  Auth->>Auth: identity adapter resolves principal
  Auth->>Route: next with principal
  Route->>Service: ensureProfile(principal)
  Service->>Data: findBySubject(principal.subject)
  Data->>Database: select from app_users by external subject
  Database-->>Data: row or no row
  Data-->>Service: AppUser or null

  opt first access, no row
    Service->>Data: create(subject, displayName)
    Data->>Database: insert into app_users
    Database-->>Data: new row
    Data-->>Service: AppUser
  end

  Service-->>Route: AppUser
  Route-->>Express: ProfileResponse parsed by contract schema
  Express-->>Client: 200 JSON with X-Request-Id
  Client-->>Hook: ProfileResponse
  Hook-->>Screen: data
  Screen-->>User: name, email, status shown

  alt not authenticated
    Auth-->>Express: AuthenticationError
    Express-->>Client: 401 problem+json with requestId
    Client-->>Hook: error
    Hook-->>Screen: isError
    Screen-->>User: sign-in message
  else database unavailable
    Data-->>Service: DataAccessUnavailableError
    Service-->>Express: error passes to error handler
    Express-->>Client: 503 problem+json with requestId
    Client-->>Hook: error
    Hook-->>Screen: isError
    Screen-->>User: error state with retry
  end
```

---

## Diagram 2 — Implementation Dependency Map

```mermaid
flowchart TD
  P1[["FEAT-004 contracts: TBI-009, TBI-010, TBI-011"]]
  P2[["FEAT-003 data-access: TBI-006"]]
  P3[["FEAT-005 principal and authenticate: TBI-012"]]
  P4[["FEAT-007 logger: TBI-016"]]

  S1["S1 — Contracts: health definitions, me check, OpenAPI"]
  S2["S2 — Data-access ping, typed errors, principal displayName"]
  S3["S3 — Composition root, error handler, TBI-014"]
  S4["S4 — Health routes and readinessService, PBI-012"]
  S5["S5 — Profile service and me routes, TBI-015, PBI-010, PBI-011"]
  S6["S6 — Route registry, drift check, log capture"]
  S7["S7 — Endpoint and probe documentation"]

  T_root{{"VT-21 to VT-27 — composition root tests"}}
  T_health{{"VT-15 to VT-20 — health tests"}}
  T_profile{{"VT-01 to VT-14, VT-30 — profile tests"}}
  T_cross(["VT-28, VT-29 — contract and log capture"])

  P1 --> S1
  P2 --> S2
  P3 --> S2
  S1 --> S3
  P3 -.-> S3
  P4 -.-> S3
  S2 --> S4
  S3 --> S4
  S1 --> S5
  S2 --> S5
  S3 --> S5
  S4 --> S6
  S5 --> S6
  S4 --> S7
  S5 --> S7

  S3 -.->|"tests"| T_root
  S4 -.->|"tests"| T_health
  S5 -.->|"tests"| T_profile
  S6 --> T_cross

  subgraph lane1 ["Can run in parallel: after prerequisites"]
    S1
    S2
  end

  subgraph lane3 ["Can run in parallel: after S3"]
    S4
    S5
  end

  subgraph lane4 ["Can run in parallel: after S4 and S5"]
    S6
    S7
  end

  subgraph legend ["Legend"]
    L1["Backend step"] --- L2[["Prerequisite from another Feature"]] --- L3{{"Unit and integration tests"}} --- L4(["Contract and log tests"])
  end
```
