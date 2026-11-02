# API documentation

The API contract is the [committed OpenAPI 3.1 document](../packages/contracts/openapi/openapi.json). It is generated from the Zod route definitions in `packages/contracts/src/routes/`, which are the single source of request and response shapes. This page does not repeat those shapes, because a second copy would drift. Read the document, or the route definition it came from.

Run `pnpm openapi:check` before you rely on the document. It exits 1 when the document is stale or is not valid OpenAPI 3.1.

## Reference endpoints

| Method and path     | Auth                    | Purpose                                                       | Definition                                |
| ------------------- | ----------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `GET /health/live`  | None                    | Liveness probe. Never touches the database                    | `packages/contracts/src/routes/health.ts` |
| `GET /health/ready` | None                    | Readiness probe. Answers 503 when the database does not reply | `packages/contracts/src/routes/health.ts` |
| `GET /api/v1/me`    | Authenticated principal | Read the caller's profile                                     | `packages/contracts/src/routes/me.ts`     |
| `PUT /api/v1/me`    | Authenticated principal | Replace the caller's editable profile fields                  | `packages/contracts/src/routes/me.ts`     |

"Authenticated principal" means the identity adapter chosen by `AUTH_MODE` returned a principal. A request without one gets `401`. The template checks no role or permission. A request never names the caller: the API takes the subject from the principal.

Status codes, error types, headers, limits, and probe settings are in the [API guide](../apps/api/README.md).

## Conventions

Every error is RFC 9457 Problem Details with `Content-Type: application/problem+json` and a `requestId`. Every response carries `X-Request-Id`. List endpoints use cursor pagination. Paths are versioned as `/api/v<n>/...`. The full rules for a new endpoint, and the helpers that enforce them, are in the [contracts guide](../packages/contracts/README.md).

## Add or change an endpoint

1. Add or edit a `defineRoute` call under `packages/contracts/src/routes/` and register it in `packages/contracts/src/registry.ts`.
2. Run `pnpm openapi:generate` and commit `packages/contracts/openapi/openapi.json` with the definition.
3. Implement the handler in `apps/api/src/routes/` and register it in `apps/api/src/app.ts`.
4. Run `pnpm check`. It runs `openapi:check` and `routes:check`, which fails when the API and the contract list different routes.
5. Run `pnpm test:contract` to check every committed operation against the document.
