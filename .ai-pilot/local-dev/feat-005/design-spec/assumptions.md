# Assumptions & Unresolved Items — Identity Provider Adapter

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

---

## Unresolved Items

Items that could not be inferred from the PRD, backlog, or codebase. Each must be decided before the relevant implementation step starts.

- ⚠ **Production identity provider is not chosen**: The backlog lists "Production identity provider decision (open)" as a dependency of this Feature. The adapter interface (`authenticate(request) → Principal | null`, headers in, one principal out) is designed without a real provider to test it against. A provider that needs more than request headers (a session store, a token refresh round trip, a logout hook, a callback route) would force a change to the interface. **Decision needed from Platform Engineering (mapped to `Platform Admin`):** name the provider, or confirm that a header-based `authenticate` call is enough. This blocks nothing in S1–S6. It blocks any claim that PBI-009 is proven against a real provider. Default if no answer: ship the interface as specified and treat the provider decision as a handoff-register entry.

- ⚠ **Display-name fallback when a provider returns no display name**: PBI-009 (c) requires handlers to work when the principal carries only the external subject. TBI-015 (Feature "Health and Self-Service Profile API", FEAT-006) creates the `app_users` row on first `GET /api/v1/me` from the principal's subject **and display name**, and `app_users` requires a display name. The `Principal` contract in this Feature makes `displayName` optional, so FEAT-006 must pick a value when it is absent. **Decision needed from the FEAT-006 owner:** use a documented constant (recommended: `"New user"`), derive it from the email local part, or reject the request. This blocks the FEAT-006 profile service step, not this Feature. Default if no answer: optional `displayName` on `Principal`; FEAT-006 falls back to a documented constant and never uses the subject as the display name.

- ⚠ **Backlog dependency edge to FEAT-002 is missing**: FEAT-005 lists `dependsOn: ["FEAT-001", "FEAT-004"]`. TBI-013 lists "Typed configuration" as a technical dependency, and S1 adds `AUTH_MODE` and a `NODE_ENV` rule to the Zod environment schema that TBI-004 (FEAT-002) creates. S5 also wires the guard into the Express composition root from TBI-014 (FEAT-006), which lists no dependencies. The implementation phases order these correctly (Phase 1 before Phase 3), but a team that picks up FEAT-005 alone from the dependency graph would start S1 without an environment schema to extend. **Decision needed from the backlog owner:** add `FEAT-002` to FEAT-005's `dependsOn`, and note TBI-014 as a soft dependency of S5. Default if no answer: S1 and S5 carry explicit "blocked by TBI-004" and "blocked by TBI-014" notes in the Implementation Plan.

- ⚠ **Which variable defines "the environment is not production"**: BR-002 and PBI-008 say the development adapter is allowed only outside production, but the PRD does not name the variable. This Feature uses `NODE_ENV`, validated as a required enum (`development`, `test`, `production`). That is safe only if every deployed environment (including shared staging) runs with `NODE_ENV=production`, which the production container sets. If Platform Engineering runs a shared non-production environment with `NODE_ENV=development`, that environment would accept every request as the synthetic principal on a reachable host. **Decision needed from Platform Engineering:** confirm that all deployed environments set `NODE_ENV=production`, or name a separate deployment-environment variable (for example `APP_ENV`) for the guard. Default if no answer: `NODE_ENV`, with the rule "every deployed environment sets `NODE_ENV=production`" written into the handoff document and the identity README.

---

## Assumptions Accepted

Inferences made during synthesis that were treated as resolved. Confirm these with stakeholders before implementation locks.

- **Output file names and location**: The task and kickoff context name the three outputs `design-doc-design.md`, `design-doc-tech-spec.md`, and `design-doc-assumptions.md` in `.ai-pilot/output/`. The skill's default path (`{slug}-design-spec/{feature-slug}-*.md`) was not used. Derived from the run instructions. Risk: a downstream consumer that expects the skill path would not find the files.

- **Non-interactive run replaces Phase 2**: The skill asks for an `AskQuestion` session. This run is non-interactive, so no questions were put to a user. Every open question is either a `⚠` item above or an assumption below with a stated default. Risk: a default may differ from what the reviewer would have chosen.

- **Template does not exist yet**: `list_repo_dir templates` returns nothing at the pinned SHA (`4d96cf6e677c8e4b9eb637bf944bc3677b12e8af`), so the whole `templates/full-stack-express/` tree is new. Derived from the repository listing. Risk: low. If another branch already created the folder, S1–S6 file paths need a re-check.

- **Template folder layout**: The PRD names five workspace members (web, API, contracts, UI, config) but no directory names. This spec uses `apps/web`, `apps/api`, `packages/contracts`, `packages/ui`, and `packages/config`, with the API entry in `apps/api/src/server.ts` (starts the process) and `apps/api/src/app.ts` (builds the Express app). Derived from common pnpm workspace layout. Risk: FEAT-001 (TBI-001) picks other names, so the paths in this spec need a rename and nothing else.

- **Backend-only surface**: The Feature adds no screen, route in the web client, or `data-testid`. The PRD's full-stack surface applies to the template as a whole. Derived from the four work items, all of which touch the API app. Risk: none known.

- **No Apex files change**: BR-008 and the kickoff "Existing Code Protection Rules" say the template holds no Apex-specific code. Apex's `ensureAuthenticated` (`src/server/middleware/auth.ts`) and `rbac-governance.mdc` are read as prior art only. The template imports nothing from Apex. Risk: none.

- **Principal shape**: `Principal` has `subject` (required, non-empty string, at most 255 characters), `displayName` (optional), and `email` (optional). It has no role, permission, group, or claim-bag field. Derived from TBI-012 ("at least the external identity subject", "no role or permission field"), TBI-015 (display name used on first access), and PBI-009 (c) (no email). Risk: the 255-character limit must match the `app_users` subject column that TBI-009/TBI-010 (FEAT-003) defines. If that column is shorter, a valid principal would fail the database write instead of being rejected here.

- **Adapter interface shape**: `IdentityProviderAdapter` has one method, `authenticate(request: AdapterRequest): Promise<Principal | null>`, where `AdapterRequest` is `{ headers }` (Node `IncomingHttpHeaders`). It returns `null` when it cannot authenticate the request. It may also throw. An optional `challenge` string supplies the `WWW-Authenticate` value. Derived from TBI-012 ("resolves a principal from a request"). Risk: see the provider ⚠ item.

- **Every non-principal outcome returns 401**: The middleware returns the Problem Details 401 when the adapter returns `null`, throws (including a provider outage or timeout), or returns a value that fails the `Principal` schema. Derived from PBI-009 (b) ("rejects or cannot verify credentials" returns 401) and PBI-008 (d). Risk: an identity-provider outage looks like bad credentials to API clients (401, not 503). The log reason code (`adapter_error`) tells operators which case occurred.

- **`WWW-Authenticate` header on every 401**: RFC 9110 requires it. The value is the adapter's `challenge`, defaulting to `Bearer`. Derived from RFC 9110 and the RFC 9457 convention in BR-005. Risk: a provider that uses cookies sets its own `challenge`.

- **Authentication is mounted once, on the `/api/v1` router**: Every route under `/api/v1` requires a principal. `/health/live` and `/health/ready` are mounted outside that router. Derived from PRD "An authentication middleware uses the adapter and protects routes" and the health endpoints requiring no authentication. Risk: if FEAT-004 route definitions later carry a per-route `auth: none` marker, the mount-level rule needs an exception list. None is planned.

- **Principal travels on `res.locals`, read through `getPrincipal(res)`**: No global Express type augmentation. `getPrincipal` throws when no principal is present, and the central error handler (TBI-014) turns that into a generic 500 Problem Details. Derived from TBI-012 ("handlers read the principal only from the middleware"). Risk: none known.

- **Environment variable names and values**: `AUTH_MODE` (required, no default) takes `development` or `provider`. `NODE_ENV` (required, no default) takes `development`, `test`, or `production`. The development adapter is allowed under `development` and `test`. Derived from PBI-008 ("authentication mode is not set" aborts naming the setting) and BR-010. Risk: FEAT-002 may already have named these differently. Align names in S1.

- **Two guards for the development adapter**: The Zod environment schema rejects `AUTH_MODE=development` with `NODE_ENV=production` (S1). The adapter factory repeats the check and the development adapter constructor refuses to build in production (S4, S5). Derived from TBI-013 ("must run before the server accepts connections") and BR-002. Risk: none. Two checks cost a few lines.

- **`provider` mode ships with no implementation**: Selecting `AUTH_MODE=provider` in the template as shipped aborts startup with a message that names the registry file to edit. Derived from the PBI-009 out-of-scope item "Shipping a specific provider implementation". Risk: a team that deploys the unmodified template to production gets a startup abort, not a running service. That is intended and goes into the handoff document.

- **Synthetic principal values**: subject `synthetic-dev-subject`, display name `Synthetic Developer`, email `synthetic.developer@example.invalid`. The `.invalid` domain is reserved by RFC 2606. The module exports the constant so seed data and tests use the same values. Derived from TBI-013 ("clearly synthetic values") and BR-007. Risk: none.

- **Development adapter ignores all request data**: It reads no header, cookie, or query value. Derived from the PBI-008 out-of-scope items "Header-based impersonation" and "Multiple synthetic principals". Risk: none.

- **Log events carry reason codes only**: `auth.rejected` logs one of `no_principal`, `adapter_error`, `invalid_principal`, plus the error class name for `adapter_error`. It never logs the error message, headers, or principal fields, because provider error messages can contain token fragments. Derived from TBI-012 and PBI-009 (b), BR-007. Risk: slower debugging of provider problems. Projects can add provider-specific diagnostics inside their own adapter, under the same redaction rule.

- **Test adapter lives under the API test folder**: `apps/api/test/support/staticAdapter.ts` is not part of the production build and cannot be selected by `AUTH_MODE`. Derived from TBI-012 ("A test adapter proves handlers read the principal only from the middleware"). Risk: none.

- **RBAC attach point is documented, not built**: The identity README names where RBAC would attach: a project-owned `authorize` middleware mounted after `authenticate` in `apps/api/src/app.ts`, reading an extended `Principal`. Derived from PBI-009 (d) and BR-003. Risk: Platform Engineering may choose a different attach point. The README states it is a suggestion.

- **Personas**: `Developer` is the template consumer. Platform Engineering maps to `Platform Admin`, as the PRD assumes. Derived from the PRD "Assumptions Made". Risk: none.

- **Verification commands**: The template's own scripts (`pnpm check`, `pnpm test`) are the verification path. Apex's `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit` must still pass unchanged because no Apex file is touched. Script names come from TBI-005. Risk: if TBI-005 names the type-check script differently, update the Header in the tech spec.
