# API

`src/index.ts` is the composition root. It reads the environment, builds the identity adapter, the persistence module, and the logger, then hands them to `createApp` in `src/app.ts` and starts listening. Tests build the same app with `createApp` and test doubles.

## Routes

The routes are defined in `packages/contracts/src/routes/`. `pnpm routes:check` fails when the app registers a route the contracts do not list, or the contracts list a route the app does not register. `pnpm check` runs it.

| Route               | Auth | Success                     | Errors                                   |
| ------------------- | ---- | --------------------------- | ---------------------------------------- |
| `GET /health/live`  | None | `200 { "status": "ok" }`    | None. It never touches the database      |
| `GET /health/ready` | None | `200 { "status": "ready" }` | `503` `not-ready`                        |
| `GET /api/v1/me`    | Yes  | `200` profile               | `401`, `429`, `500`, `503`               |
| `PUT /api/v1/me`    | Yes  | `200` profile               | `400`, `401`, `413`, `429`, `500`, `503` |

A profile is:

```json
{
  "displayName": "Synthetic Developer",
  "email": "dev@example.test",
  "status": "active"
}
```

`email` is a string or `null`. `status` is `active` or `disabled`. The body never contains the subject, the row ID, or timestamps.

The first authenticated request for a subject creates its row, whether that request is a `GET` or a `PUT`. The new row takes the display name the identity provider sent, trimmed and cut to 100 characters, or `New user` when the provider sent none. It never uses the subject as a name.

`PUT /api/v1/me` replaces both editable fields:

```json
{ "displayName": "Ada Lovelace", "email": "ada@example.test" }
```

| Field         | Rule                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| `displayName` | Required. Trimmed, then 1 to 100 characters. Characters are Unicode code points |
| `email`       | Optional. Trimmed, at most 254 characters. Omitted, `null`, or blank clears it  |

Any other key, including `subject`, `id`, and `status`, fails validation. The body limit is 16 KB.

Every response carries `X-Request-Id`. A caller may send its own value matching `^[A-Za-z0-9._-]{1,64}$`; otherwise the API generates one. `/api` and `/health` responses carry `Cache-Control: no-store`.

## Errors

Every error is RFC 9457 Problem Details with `Content-Type: application/problem+json`. The body has `type`, `title`, `status`, `detail`, and `requestId`. A `400` validation failure adds `errors`, one entry per field, each with `pointer` (for example `/displayName`), `code`, and `message`. No entry repeats the submitted value.

| Status | `type`                                     | Cause                                                                           |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| 400    | `urn:problem-type:validation-error`        | The body fails the contract                                                     |
| 400    | `urn:problem-type:malformed-body`          | The body is not valid JSON                                                      |
| 401    | `urn:problem-type:authentication-required` | The identity adapter returned no principal                                      |
| 404    | `urn:problem-type:not-found`               | No route under `/api` or `/health` matches                                      |
| 413    | `urn:problem-type:payload-too-large`       | The body is larger than 16 KB                                                   |
| 429    | `urn:problem-type:rate-limited`            | The rate limit is on and the caller passed it. `Retry-After` says when to retry |
| 500    | `urn:problem-type:internal-error`          | Anything unexpected                                                             |
| 503    | `urn:problem-type:service-unavailable`     | The database is unreachable. Nothing was changed                                |
| 503    | `urn:problem-type:not-ready`               | The readiness probe failed, or the process is shutting down                     |

A `500`, or a `503` from the database, writes one `request.failed` log line with the request ID, the status, the error class name, and the SQLSTATE when there is one. It never logs the message, the stack, the body, or the principal.

## Probes

Point the liveness probe at `/health/live` and the readiness probe at `/health/ready`. Neither needs credentials. Readiness runs `select 1` and answers `503` when the database does not reply within `READINESS_TIMEOUT_MS`. Set the platform's probe timeout above that value, or the platform gives up before the API answers. Readiness checks connectivity only; it does not check that migrations ran.

## Deploying

Run `pnpm migrate`, then deploy. The API never changes the schema when it starts, and a request against a missing table answers `500`.

Start the API with `node --import ./dist/instrument.js dist/index.js`. See the template README for shutdown and telemetry settings.

## Settings

| Variable               | Default | Meaning                                                                                      |
| ---------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `READINESS_TIMEOUT_MS` | `2000`  | Readiness and pool connection timeout, 100 to 10000                                          |
| `RATE_LIMIT_MAX`       | unset   | Requests per window per client IP under `/api`. Unset turns the limiter off                  |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window, 1000 to 3600000                                                           |
| `CLIENT_DIST_DIR`      | unset   | Directory of the built web client, relative to the working directory. Unset serves no client |

The rate limiter counts in memory, so each instance keeps its own counts. Behind a proxy, set Express `trust proxy` in `src/app.ts` so `req.ip` is the client rather than the proxy. To share counts across instances, replace `createRateLimit` in `src/index.ts` with a limiter backed by a shared store; `createApp` takes any middleware as `rateLimiter`.

When `CLIENT_DIST_DIR` holds an `index.html`, the API serves its files and answers any other `GET` outside `/api` and `/health` with `index.html`, so client-side routes work on reload.
