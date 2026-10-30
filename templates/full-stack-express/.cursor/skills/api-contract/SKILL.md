---
name: api-contract
description: Rules for adding or changing an HTTP endpoint so the Zod route definition stays the source of truth, OpenAPI stays generated, and errors, pagination, and authentication match the contract. Use when adding a route, changing a request or response, or reviewing an API change.
---

# API contract

Follow this skill before writing or changing an endpoint. The contracts package is the authority. Handlers, the OpenAPI document, and tests follow it.

## When to use

Use this skill when a task adds or changes an HTTP endpoint, a request or response schema, or an error the API returns. Do not use it for a screen with no API change. That work uses the UI standards skill.

## Required references

Read these before editing. Stop if any path is missing.

- [Contract conventions](../../../packages/contracts/README.md) and `packages/contracts/src/define-route.ts`
- Route registry: `packages/contracts/src/registry.ts`
- Worked routes: `packages/contracts/src/routes/health.ts` and `packages/contracts/src/routes/me.ts`
- Problem Details: `packages/contracts/src/conventions/problem-details.ts`
- Request ID: `packages/contracts/src/conventions/request-id.ts`
- Pagination: `packages/contracts/src/conventions/pagination.ts`
- Committed document: `packages/contracts/openapi/openapi.json`
- API guide: [docs/api.md](../../../docs/api.md)
- Quality gates: `quality/quality-manifest.json` and [quality/README.md](../../../quality/README.md)
- Authentication: `apps/api/src/identity/authMiddleware.ts`
- Questions: [build artifacts](../../../docs/plans/README.md) (`docs/plans/README.md`)

## Rules

The Enforced by cell is a gate id from `quality/quality-manifest.json`, or `Review`. The `routes-check` gate runs `pnpm routes:check`. The `contract` gate runs `pnpm test:contract`. Name that gate when the command is what enforces the rule. Do not claim a gate enforces a rule it does not run.

| ID      | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Enforced by   |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| API-R01 | Declare every route once in the contracts package: method, versioned path, request, response, and error schemas. No handler exists without a definition. `pnpm routes:check` exits 1 and prints `routes:check: <METHOD> <path> is registered but has no contract`. The `routes-check` gate runs that command, and `pnpm check` runs it too.                                                                                                                                 | routes-check  |
| API-R02 | Never edit `packages/contracts/openapi/openapi.json` by hand. Run `pnpm openapi:generate` and commit its output with the definition.                                                                                                                                                                                                                                                                                                                                        | openapi-drift |
| API-R03 | The contracts package imports no Express, React, or database module. It imports `zod` only. `src/` imports no `node:` module.                                                                                                                                                                                                                                                                                                                                               | build         |
| API-R04 | Version every path as `/api/v1/...` (probes stay `/health/...`) and name resources with nouns. GET reads. PUT replaces. 2xx is success, 4xx is a client fault, 5xx is a server fault. `pnpm test:contract` checks statuses and shapes. Naming is review.                                                                                                                                                                                                                    | Review        |
| API-R05 | Return every error as RFC 9457 Problem Details from `problemDetailsSchema`, with `application/problem+json`. The route definition declares each error it can return. `defineRoute` adds 500, and 401 and 429 on principal routes, and 400 when the route has input. `pnpm test:contract` checks those responses.                                                                                                                                                            | Review        |
| API-R06 | Every response carries the `X-Request-Id` header, and the route definition declares it. A Problem Details body repeats it as `requestId`.                                                                                                                                                                                                                                                                                                                                   | api           |
| API-R07 | Parse the request with the route's request schema before the handler runs. Handlers receive parsed values only. A schema failure is 400 Problem Details of type `urn:problem-type:validation-error`.                                                                                                                                                                                                                                                                        | api           |
| API-R08 | An error body, log line, or telemetry attribute never holds a stack trace or an identity value (display name, email, external subject). Build `errors[]` with `zodIssuesToProblemErrors`. The entry has a pointer, a code, and a fixed message. It does not repeat the submitted value.                                                                                                                                                                                     | api           |
| API-R09 | A list route uses `paginationQuerySchema`: `limit` is an integer from 1 to 100 and defaults to 20. A larger value returns 400 Problem Details. The response uses `paginated(item)`: `items` and `nextCursor` (`null` on the last page). The reference API has no list route; this schema is the worked example.                                                                                                                                                             | unit          |
| API-R10 | Every route except `GET /health/live` and `GET /health/ready` runs behind `createAuthMiddleware`. An unauthenticated request returns 401 Problem Details. Declare `auth: 'principal'` or `auth: 'none'`.                                                                                                                                                                                                                                                                    | api           |
| API-R11 | On the profile resource, read the external subject from the authenticated principal with `getPrincipal`. The handler never reads an identifier from the path, query, or body. `defineRoute` throws if `params`, `query`, or `body` includes `userId`, `subject`, `sub`, `externalSubject`, or `externalId`. Request objects use `z.strictObject`, so an unknown key, including another person's identifier, returns 400 Problem Details and leaves the other row unchanged. | api           |
| API-R12 | Define no roles, permissions, or authorization policy. Report a request for them as the open decision in [ADR 0002](../../../docs/adr/0002-no-roles-or-permissions-in-the-template.md).                                                                                                                                                                                                                                                                                     | Review        |
| API-R13 | Give every route at least one contract test that calls it and validates the response, errors included, against the committed OpenAPI schema. `pnpm test:contract` exits non-zero and names a missing operation. The `contract` gate runs that command.                                                                                                                                                                                                                      | contract      |
| API-R14 | Use synthetic values in schema examples, tests, and documents. Display names are invented. Email addresses use the `example.test` domain.                                                                                                                                                                                                                                                                                                                                   | Review        |
| API-R15 | Undocumented or incompatible behavior fails `pnpm openapi:check` or `pnpm test:contract`. Fix the code or the definition and regenerate. Never loosen a check to pass it.                                                                                                                                                                                                                                                                                                   | openapi-drift |

## Adding an endpoint

1. Read Required references. Stop if any path is missing.
2. Confirm the endpoint is in scope. No user list, create, or lookup. No roles or permissions.
3. Add one `defineRoute` under `packages/contracts/src/routes/` and register it in `packages/contracts/src/registry.ts`. Use a versioned path, request, response, and error schemas, and the request ID header. Reuse `problemDetailsSchema` and, for a list, `paginationQuerySchema`.
4. Run `pnpm openapi:generate`. Commit `packages/contracts/openapi/openapi.json` with the definition. Do not edit that file by hand.
5. Register the handler from the definition in `apps/api/src/app.ts`. Take the subject from `getPrincipal`. Call the service and the data-access module. Do not query the database from the handler.
6. Add tests for success, validation failure, unauthenticated access, database failure, and, for a principal-scoped resource, a cross-principal case. Put HTTP cases that belong to the API gate in `apps/api/test/api/`.
7. Add or extend a test under `apps/api/test/contract/` so the new route and its error responses are covered.
8. Run `pnpm typecheck`, `pnpm lint`, `pnpm openapi:check`, `pnpm routes:check`, `pnpm test:api`, and `pnpm test:contract`. Fix failures in the code or the definition.
9. Add the endpoint to `docs/api.md`, then run `pnpm docs:check`.

## Review checklist

Mark each item yes, no, or not applicable. A no is a failure. Evidence is a file, a command result, or this skill.

| Item                                                                              | Evidence source                                                             | Met? (yes, no, not applicable) |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| One `defineRoute` exists and the handler is registered (API-R01)                  | `pnpm routes:check` output                                                  |                                |
| OpenAPI document was generated, not edited (API-R02, API-R15)                     | `pnpm openapi:check`                                                        |                                |
| Contracts package stays free of Express, React, and database imports (API-R03)    | `pnpm build`                                                                |                                |
| Path, method, and status codes match the meaning rules (API-R04)                  | Route definition and `pnpm test:contract`                                   |                                |
| Errors are Problem Details declared on the route (API-R05, API-R08)               | `pnpm test:contract` and `pnpm test:api`                                    |                                |
| Responses declare `X-Request-Id` (API-R06)                                        | Route definition and `pnpm test:api`                                        |                                |
| The request schema parses input before the handler (API-R07)                      | `pnpm test:api` validation case                                             |                                |
| A list route sets default 20 and maximum 100 and rejects a larger limit (API-R09) | `packages/contracts/src/conventions/pagination.ts` and the route definition |                                |
| Non-health routes require a principal (API-R10)                                   | `pnpm test:api` unauthenticated case                                        |                                |
| Profile handlers ignore caller identifiers and unknown keys return 400 (API-R11)  | `pnpm test:api` cross-principal case                                        |                                |
| No roles or permissions were added (API-R12)                                      | Diff and ADR 0002                                                           |                                |
| Contract tests cover the route (API-R13)                                          | `pnpm test:contract`                                                        |                                |
| Examples and tests use synthetic values (API-R14)                                 | Diff                                                                        |                                |

## Stop conditions

Stop and report the missing piece. Do not guess.

- A required reference path or command does not exist.
- The task asks for a user list, user create, user lookup, roles, or permissions. If the brief has no Authorization answer, ask the Authorization question in `docs/plans/README.md` verbatim and write no endpoint. A Stay answer keeps the route on the caller's own data. A Pause answer stops. Do not invent a role model.
- The task asks for a production identity provider. Ask the Identity question in `docs/plans/README.md` verbatim and write no endpoint until the brief records Keep or Pause.
- The task asks for pipeline, cloud-host, or infrastructure changes.
- `pnpm routes:check` or `pnpm test:contract` is missing, so the `routes-check` or `contract` gate has no command behind it.
