# Assumptions & Unresolved Items — Health and Self-Service Profile API

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

**Session note.** This run was non-interactive, so Phase 2 (user refinement) did not ask questions. Each ⚠ item below carries the default the specs use. If the team picks another option, update the linked VT rows named in the item.

---

## Unresolved Items

Items that the PRD, backlog, and codebase do not settle. Each must be decided before the relevant implementation step starts.

- ⚠ **`PUT /api/v1/me` before any `GET`**: The PRD assumption says `GET /api/v1/me` is "the only way a profile can come to exist". Neither PBI-011 nor TBI-015 says what `PUT` does when the principal has no `app_users` row. This decides the service logic in S5 and whether VT-14 asserts 200 or 404. **Default used:** `PUT` creates the row from the principal, then applies the update (one `ensureProfile` call shared by both routes). A 404 on `/me` would tell an authenticated person that their own resource does not exist. **Decision needed:** confirm the default, or choose a 404 Problem Details response and change the PRD assumption to match.

- ⚠ **Display name on the principal contract**: TBI-012 requires the principal to carry "at least the external identity subject". TBI-015 creates the profile "using the principal's subject and display name". If an adapter returns only a subject, the service has no display name, and `app_users.display_name` is required (an empty display name fails validation on update). This blocks S5 and the FEAT-005 principal type. **Default used:** the principal contract carries an optional `displayName`; the service stores `displayName.trim()` when present and the literal `User` otherwise. It never stores the subject as a display name. **Decision needed:** FEAT-005 owners confirm the optional field, or make it required and move the fallback into each adapter.

- ⚠ **Body of the `/health/ready` 503 response**: BR-005 says every error response uses Problem Details. PBI-012 says readiness "returns a not-ready status" and its BR says responses "follow the documented contract". A 503 from readiness is either an error (Problem Details) or a status document (`{ "status": "not_ready" }`). This decides the contract definition in S1 and the assertions in VT-17, VT-18, and VT-19. **Default used:** Problem Details (`application/problem+json`, status 503, type `not-ready`, fixed detail text, `requestId`). It follows BR-005 literally and keeps one error shape for the whole API. Orchestrators read the status code, so both options work for them. **Decision needed:** confirm Problem Details, or approve a dedicated `HealthStatus` body for the 503 as a documented exception to BR-005.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

**Scope and layout**

- **Template folder layout**: The PRD names the workspace members (web, API, contracts, UI, config) but not their paths. This spec uses `templates/full-stack-express/apps/api/` and `templates/full-stack-express/packages/contracts/`. Source: TBI-001 description. Risk: if TBI-001 picks other paths, rename the paths in the tech spec only. No design decision changes.
- **Surface is backend only**: The backlog gives this Feature the `route` value `/profile/details/edit`, which looks like a screen path. The PRD puts the profile screen in FEAT-010 (PBI-019, PBI-020). This Feature ships endpoints only, and the design doc marks UI/UX "Not applicable". Risk: if a screen was intended here, FEAT-010 already covers it and nothing is lost.
- **Apex rules are references, not constraints**: `.cursor/rules/rbac-governance.mdc`, `postgresql-db.mdc`, and the `fullstack-node-bff` skill describe Apex code. The template holds no Apex code (BR-008), so the spec follows their patterns where the PRD allows and names each deviation: Problem Details instead of `{ error }` bodies (BR-005), Drizzle Kit migrations instead of `node-pg-migrate` (BR-006), no permission keys (BR-003). Risk: none for Apex runtime. The template never imports Apex code.
- **No Apex RBAC change**: The Feature adds no permission key, `can()` guard, `requirePermission` call, or migration to Apex. The `rbac-management` skill is not needed. Source: BR-003 and the PRD access table.

**Profile contract**

- **Contract shapes are requirements for FEAT-004**: TBI-009 owns the profile route definitions. This spec fixes the shapes it needs (tech spec, Data and Contracts) and S1 checks that TBI-009 matches. Risk: if TBI-009 lands with different limits or field names first, S1 reconciles them before S5 starts.
- **Response fields**: `displayName`, `email` (string or `null`), `status`. The response omits the external subject and the internal UUID. Source: PBI-010 (a) lists exactly these fields, and BR-007 treats the subject as an identity value. Risk: a later client that needs the UUID adds it in a new minor version.
- **Field limits**: `displayName` is trimmed, 1 to 100 Unicode code points. `email` is trimmed, a valid address, at most 254 characters. The PRD says only "maximum allowed length". Source: RFC 5321 for 254; 100 is a conventional name limit. Apex counts bio length in code points (`PROFILE_BIO_MAX_CODE_POINTS` in `src/shared/types/profile.ts`), and the template follows that. Risk: FEAT-003 must size the `app_users` columns to at least these limits.
- **`PUT` replaces the editable fields**: `displayName` is required. An omitted `email`, a `null`, or a whitespace-only string all store no email. Apex precedent: `normalizeAndValidateBio` turns whitespace-only input into `null`. Risk: a client that sends only `displayName` clears the email. The OpenAPI document states this.
- **Unknown fields**: The `PUT` body schema is strict. A body with `subject`, `externalSubject`, `id`, `status`, or any other extra key returns 400 and names the field. PBI-011 allows "rejected or ignored" and this spec picks rejected, following Apex's `parseUpdateCurrentProfileRequest`. `GET` ignores unknown query parameters and headers, because PBI-010 (d) requires that an added identifier has "no effect". Risk: none beyond stricter clients.
- **Status is display-only**: The API never reads `status` to allow or deny a request (BR-003: no authorization policy). New rows get `active`. The value set belongs to FEAT-003 (PRD assumption: implementation chooses a small documented set). Risk: a reviewer may expect a disabled user to get a 403. That needs an RBAC decision from Platform Engineering.
- **First-access race**: Two simultaneous first requests for one new principal both try to insert. The service catches the typed unique-constraint error from the data-access module, reads the row again once, and returns it. A second conflict returns 500. Risk: none for correctness, because the unique constraint on the subject holds.

**Health contract**

- **Health routes are unversioned**: `/health/live` and `/health/ready` sit outside `/api/v1` (PRD endpoint list) and appear in the OpenAPI document with no security requirement. Rate-limit hooks skip them, so a limit cannot make a probe return 429. Info-level access logs skip them too.
- **Readiness checks connectivity only**: Readiness runs `select 1` through the data-access module. It does not check that `app_users` exists. Migrations run as a separate deployment step owned by Platform Engineering (BR-006). Risk: an instance deployed before its migration reports ready and returns 500 from `/api/v1/me`. The template runbooks (Agent Guidance and Knowledge Base epic) must state "migrate, then deploy".
- **Readiness deadline**: Default 2000 ms, set by `READINESS_TIMEOUT_MS` (name assumed; TBI-004 validates it as an integer from 100 to 10000). The PRD says only "within the time limit". Risk: the probe timeout in Platform Engineering's orchestrator must exceed this value. The handoff document lists both.
- **Data-access gets a `ping` method**: TBI-006 lists find, create, and update. Readiness needs a bounded connectivity check, and the same TBI says the data-access module is the only code that imports the Drizzle client. So this Feature adds `ping()` to that module's interface instead of importing the pool in the health route. Apex prior art uses the Drizzle `sql` template tag for health checks (`postgresql-db.mdc`). Risk: it changes a module FEAT-003 owns, so S2 needs that owner's review.
- **Typed database errors**: The data-access module maps connection-class failures (refused, reset, timeout, shutdown) to `DataAccessUnavailableError` and unique violations to `UniqueViolationError`. The error handler returns 503 for the first and 500 for any other database error. Source: TBI-006 NFR ("typed errors, not raw database errors"). Risk: an unmapped connection error returns 500 instead of 503.

**Platform behavior**

- **Auth is mounted on the `/api/v1` router**: `app.use('/api/v1', authenticate, v1Router)`, the same shape as `app.use('/api/my-feature', ensureAuthenticated, routes)` in the `fullstack-node-bff` skill. A future route under `/api/v1` is protected without extra wiring.
- **Request ID header**: `X-Request-Id`, generated by the server for every request (TBI-014). TBI-011 owns the header declaration in the contracts package. The Problem Details `requestId` member repeats the header value.
- **Response caching**: `/api/v1/me` and both health routes send `Cache-Control: no-store`, so shared proxies never cache personal data or a stale readiness answer.
- **JSON body limit**: 16 KB. A larger `PUT` body returns 413 Problem Details. The profile body is far smaller.
- **Verification commands**: The template's named scripts (TBI-005) are `pnpm build`, `pnpm check`, and `pnpm test`, run from `templates/full-stack-express/`. Exact script names follow TBI-005. The Apex root checks must stay unchanged (see the tech spec header).
- **Test tools**: Vitest, Supertest (named in TBI-014), and Testcontainers (PRD Testing Decisions). Apex prior art for the health test is `src/server/__tests__/healthDb.test.ts`.
- **Build order**: FEAT-005 (identity) and FEAT-007 (logging) sit in the same epic and phase as this Feature. S3 may start against their interfaces with test doubles and switch to the real modules when they land.
