# Identity

This module answers one question for every request under `/api/v1`: who is calling. It does not decide what the caller may do. The identity provider owns identities; the API stores no passwords and no sessions.

Import everything from `apps/api/src/identity/index.ts`.

## Contract

`Principal` is the authenticated caller:

| Field         | Type     | Required | Meaning                                                      |
| ------------- | -------- | -------- | ------------------------------------------------------------ |
| `subject`     | `string` | Yes      | The provider's stable id for the person, 1 to 255 characters |
| `displayName` | `string` | No       | A name the provider supplies                                 |
| `email`       | `string` | No       | An email the provider supplies                               |

There is no role, permission, group, or claims field. A handler must work with `subject` alone.

`IdentityProviderAdapter` resolves a principal from a request:

```ts
interface IdentityProviderAdapter {
  readonly challenge?: string; // WWW-Authenticate value, default "Bearer"
  authenticate(request: {
    headers: IncomingHttpHeaders;
  }): Promise<Principal | null>;
}
```

The adapter sees request headers only. It returns a `Principal`, returns `null` when it cannot authenticate the request, or throws.

`createAuthMiddleware({ adapter, logger })` returns the `authenticate` middleware. Mount it once, after `requestId()`, in front of the versioned router:

```ts
const authenticate = createAuthMiddleware({ adapter, logger });
app.use('/api/v1', authenticate, v1Router);
```

Health routes are mounted before this line and stay public. For each request the middleware calls the adapter and checks the result against `principalSchema`:

- A valid principal is frozen and stored for the request; the handler reads it with `getPrincipal(res)`.
- `null`, a throw, or an invalid principal returns `401` with an RFC 9457 Problem Details body (`application/problem+json`, type `urn:problem-type:authentication-required`, detail `Authentication is required.`, and the request ID). The response carries `WWW-Authenticate` with the adapter's `challenge` and the `X-Request-Id` header. The handler never runs.

`getPrincipal(res)` is the only way a handler learns who is calling. Never read identity from headers, the query, or the body. On a route that is not behind the middleware, `getPrincipal` throws `PrincipalMissingError`, which the error handler turns into a generic `500`.

## Development adapter

`AUTH_MODE=development` selects `createDevelopmentAdapter`. Every request runs as `DEVELOPMENT_PRINCIPAL`:

| Field         | Value                                 |
| ------------- | ------------------------------------- |
| `subject`     | `synthetic-dev-subject`               |
| `displayName` | `Synthetic Developer`                 |
| `email`       | `synthetic.developer@example.invalid` |

The adapter reads nothing from the request, so no header can pick another identity. It logs one `auth.development_adapter_active` warning at startup. The example env file already sets `AUTH_MODE=development` and `NODE_ENV=development`; nothing else is needed.

`AUTH_MODE` and `NODE_ENV` have no default. Startup stops before any port opens when `AUTH_MODE` is unset or invalid, and when `AUTH_MODE=development` is combined with `NODE_ENV=production`. Three places enforce the second rule: the environment schema, `createIdentityAdapter`, and the development adapter itself.

`NODE_ENV` is the production signal. Every deployed environment, including shared staging, must set `NODE_ENV=production`, so the development adapter can never serve a reachable host.

## Add a production identity provider

`AUTH_MODE=external` selects the adapter registered in `apps/api/src/identity/registry.ts`. The template ships with none registered, so `AUTH_MODE=external` stops startup with `AUTH_MODE=external requires an adapter registered in apps/api/src/identity/registry.ts.` until you add one.

1. Write a class or object that implements `IdentityProviderAdapter`, for example `apps/api/src/identity/myProviderAdapter.ts`.
2. In `authenticate`, read the credential from the headers and verify it with the provider (signature, issuer, audience, expiry) before returning a principal. Return `null` when the credential is missing or rejected. Throw, or return `null`, when the provider cannot be reached; both give the caller a `401`.
3. Map the provider's subject claim to `subject`. Map `displayName` and `email` only when the provider supplies them.
4. Set `challenge` when the scheme is not `Bearer`.
5. In `registry.ts`, replace `undefined` in `registeredExternalAdapter` with a factory that returns your adapter. Read any provider settings through `apps/api/src/config/env.ts`, and add each new variable to `.env.example`.
6. Deploy with `AUTH_MODE=external` and `NODE_ENV=production`.

Route handlers do not change.

## Test adapter

Tests use `createStaticAdapter` from `apps/api/test/support/staticAdapter.ts`. It returns a fixed principal, `null`, or the result of a function, and ignores the request. Build a test app with `createAuthMiddleware({ adapter: createStaticAdapter(...), logger })` to prove that a handler reads the principal from the middleware. The test adapter is not part of the build and `AUTH_MODE` cannot select it.

## Logging

The middleware logs `auth.rejected` at `warn` with a `reason` of `no_principal`, `adapter_error`, or `invalid_principal`. For `adapter_error` it adds `errorName`, the error class name. It never logs the error message, request headers, tokens, or any principal field, because provider error messages can hold token fragments. A provider adapter follows the same rule: never put a credential or identity value in a log field or message.

## Roles and RBAC

The template defines no roles or permissions. `Principal` has no role field, and no route checks one.

A project that needs authorization owns it. The suggested attach point is an `authorize` middleware mounted after `authenticate` in `apps/api/src/app.ts`, for example `app.use('/api/v1', authenticate, authorize, v1Router)`. It would read an extended `Principal` that the project's adapter fills from provider claims. This is a suggestion; Platform Engineering may choose another attach point.
