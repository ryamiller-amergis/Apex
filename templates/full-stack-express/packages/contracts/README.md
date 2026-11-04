# @project-scope/contracts

Each API route is defined once here, in Zod. The API validates requests with these schemas, the web client parses responses with them, both derive their TypeScript types from them, and `openapi/openapi.json` is generated from them. Do not edit that file by hand.

The package imports only `zod`. It has no dependency on Express, React, or the database, and `src/` imports no `node:` module, so the web bundle can import it. The scripts under `scripts/` run on Node and are not exported.

Run every command below from `templates/full-stack-express/`.

## Add an endpoint

1. Add a `defineRoute({ ... })` call under `src/routes/`, and add it to `routes` in `src/registry.ts`.
2. Regenerate the document and commit it with the definition:

   ```sh
   pnpm openapi:generate
   ```

3. Prove the document matches the definitions. `pnpm check` runs the same command.

   ```sh
   pnpm openapi:check
   ```

   When the committed document is stale, the check prints a unified diff, names each route missing from the committed file, and exits 1. It also exits 1 when the committed document is not valid OpenAPI 3.1.

## Conventions for new endpoints

`defineRoute` enforces most of these rules when the module loads, so a broken definition fails every command that imports it.

- **Versioned paths.** A path is `/api/v<n>/...` or `/health/...`. Path parameters use Express syntax (`:thingId`), and the `params` schema keys must equal them. A breaking change to a published route goes under the next version, such as `/api/v2/...`.
- **One definition per route.** Give each route an `id` in camelCase. It becomes the OpenAPI `operationId`. Declare `auth: 'principal'` for routes that need an authenticated caller and `auth: 'none'` for probes.
- **Strict schemas.** Use `z.strictObject` for request and response objects. Unknown request fields fail validation, and a response with an extra field fails its schema.
- **No caller identifiers.** A request never names the caller. `defineRoute` throws when `params`, `query`, or `body` has a field named `userId`, `subject`, `sub`, `externalSubject`, or `externalId`. The API takes the subject from the authenticated principal. The list is `forbiddenIdentifierFields` in `src/define-route.ts`.
- **Errors are Problem Details.** Every 4xx and 5xx response uses `problemDetailsSchema` and the `application/problem+json` content type. `defineRoute` adds `500` to every route, `401` and `429` to `principal` routes, and `400` to routes with any input. The `type` member is one of `problemTypes` (`urn:problem-type:validation-error`, `malformed-body`, `authentication-required`, `not-found`, `rate-limited`, `not-ready`, `internal-error`, `service-unavailable`, `payload-too-large`). Malformed JSON and schema failures both return `400`; the `type` tells them apart.
- **No values in error bodies.** Build `errors[]` with `zodIssuesToProblemErrors(issues)`. Each entry has a JSON `pointer`, the Zod issue `code`, and a fixed `message` per code. It never repeats the submitted value. Problem Details bodies never carry a stack trace or an identity value, and the strict schema rejects a body that tries.
- **Request ID header.** Every response, success or error, carries `X-Request-Id`: 1 to 128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, and `-`. Every Problem Details body repeats it as `requestId`.
- **Pagination.** List endpoints use `paginationQuerySchema` as their query: `limit` is an integer from 1 to 100 with default 20 (maximum 100), and `cursor` is an opaque string of at most 512 characters. Wrap the item schema with `paginated(item)` for the response, `{ items, nextCursor }`, where `nextCursor` is `null` on the last page.
- **Synthetic examples only.** Examples are optional. When you add one, use synthetic values such as `Ada Example` and `ada@example.test`. `defineRoute` checks each example against its schema, and a test fails on any email outside `example.test` or `example.com`.
- **JSON only.** Request and success bodies use `application/json`.
- **Regenerate with every change.** Run `pnpm openapi:generate` and commit `openapi/openapi.json` in the same change as the definition. `pnpm openapi:check` fails until you do.

## Consuming the contracts

| Consumer              | Import                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API application       | `routes`, `routeList`, `InferBody`, `InferParams`, `InferQuery`, `InferResponse`, `zodIssuesToProblemErrors`, `problemTypes` from `@project-scope/contracts` |
| `routes:check` in API | `compareRouteInventory(registered)` from `@project-scope/contracts`. It returns `ok`, `undocumented`, and `unimplemented`, and throws when given no routes   |
| Web client            | `routes`, `InferBody`, `InferResponse`, `problemDetailsSchema` from `@project-scope/contracts`. Parse every response with the route's schema                 |
| Conformance tests     | `buildOpenApiDocument` from `@project-scope/contracts/openapi`, and the committed document from `@project-scope/contracts/openapi.json`                      |
| QA                    | Read `packages/contracts/openapi/openapi.json`. Run `pnpm openapi:check` first, so a stale document fails before anyone relies on it                         |
| Quality manifest      | `pnpm openapi:check` is the drift gate                                                                                                                       |
| `api-contract` Skill  | Teach the conventions above                                                                                                                                  |

The API and web packages import the build output in `dist/`, so run `pnpm build` before `pnpm typecheck` or `pnpm test`.

Derive types instead of writing interfaces:

```ts
import {
  routes,
  type InferBody,
  type InferResponse,
} from '@project-scope/contracts';

type UpdateProfile = InferBody<typeof routes.putMe>;
type Profile = InferResponse<typeof routes.getMe, 200>;
```

`profileStatusValues` lists the profile `status` values. The data-access module checks its stored values against that list with `satisfies`, because this package cannot import the database layer.
