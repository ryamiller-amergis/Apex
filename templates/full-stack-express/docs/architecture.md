# Architecture

This repository is a pnpm workspace with two applications and three shared packages. A React web client calls an Express API. Both import their request and response types from one contracts package. The API stores data in PostgreSQL. The [module map](module-map.md) lists each member's responsibility and public interface.

## Workspace layout

| Member                | Package name               | Role                                                                   |
| --------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `apps/web/`           | `@project-scope/web`       | React single-page client built with Vite                               |
| `apps/api/`           | `@project-scope/api`       | Express API, migration and seed commands                               |
| `packages/contracts/` | `@project-scope/contracts` | Zod route definitions and the generated OpenAPI document               |
| `packages/ui/`        | `@project-scope/ui`        | MUI design system: tokens, themes, application shell, state components |
| `packages/config/`    | `@project-scope/config`    | Shared TypeScript, ESLint, Prettier, Vitest, and coverage settings     |

Dependencies point one way. The applications import the packages. No package imports an application, and the two applications never import each other. The contracts package imports only `zod`, so the browser bundle can include it.

The members are listed in `pnpm-workspace.yaml`. Every dependency version comes from the `catalog:` in that file and appears in the [compatibility table](compatibility.md).

## Request flow

1. The browser loads the built client. In production the API serves it from `CLIENT_DIST_DIR`. In development Vite serves it and proxies `/api` and `/health` to the API.
2. The client calls a route through `apps/web/src/api/apiClient.ts` and parses the response with the route's Zod schema from `@project-scope/contracts`.
3. The API assigns a request ID, logs the request, and authenticates the caller through the identity adapter chosen by `AUTH_MODE`.
4. The route handler validates the body against the same Zod schema, calls a service in `apps/api/src/services/`, and the service calls the persistence module.
5. Errors leave as RFC 9457 Problem Details. The body names the problem type and the request ID and never repeats a submitted value.

`apps/api/src/app.ts` wires the middleware and routes. `apps/api/src/index.ts` is the composition root: it reads the environment, builds the identity adapter, persistence, logger, and telemetry, then starts listening.

## Data

PostgreSQL holds one example table, `app_users`. Its Drizzle schema is `apps/api/src/persistence/schema.ts`. Only `apps/api/src/persistence/` may import Drizzle or the `pg` driver, and ESLint enforces that boundary.

Migrations are SQL files under `apps/api/drizzle/`, generated from the schema and committed with it. The API never changes the schema when it starts. `pnpm migrate` applies pending files, and Platform Engineering runs it before traffic switches. Production rollback is a new corrective migration. See the [migrations runbook](runbooks/migrations.md) and [ADR 0003](adr/0003-forward-only-production-migrations.md).

## API contract

Each route is defined once in `packages/contracts/src/routes/` and registered in `packages/contracts/src/registry.ts`. The committed `packages/contracts/openapi/openapi.json` is generated from those definitions. `pnpm openapi:check` fails when it is stale, and `pnpm routes:check` fails when the API's registered routes and the contract differ. See [API documentation](api.md) and [ADR 0001](adr/0001-zod-contracts-are-the-api-authority.md).

## Identity

`AUTH_MODE` picks the identity adapter and has no default. `development` runs every request as one synthetic principal and is refused when `NODE_ENV` is `production`. `external` uses the adapter registered in `apps/api/src/identity/registry.ts`; none ships with the template. The template defines no roles or permissions. See the [identity guide](../apps/api/src/identity/README.md) and [ADR 0002](adr/0002-no-roles-or-permissions-in-the-template.md).

## Configuration

The API reads every environment variable in `apps/api/src/config/env.ts` and stops before it listens when a value is missing or invalid. The message names each bad variable and never prints a value. The web client reads its build-time variables in `apps/web/src/config/env.ts`. Every variable is listed in `.env.example`.

Feature flags go through the `FlagEvaluator` interface in `apps/api/src/feature-flags/`. The local adapter reads the optional `FEATURE_FLAGS` variable.

## Observability and shutdown

The API writes JSON log lines to stdout with Pino. Lines inside a request carry `requestId` and `correlationId`. OpenTelemetry traces and metrics are exported over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `apps/api/src/instrument.ts` must load before the application, so start the built API with `node --import ./dist/instrument.js dist/index.js`.

On `SIGTERM` or `SIGINT` the API stops accepting connections, lets running requests finish within `SHUTDOWN_TIMEOUT_MS`, closes the database, and flushes telemetry. Liveness is `GET /health/live`; readiness is `GET /health/ready`.

## Quality and delivery

`quality/quality-manifest.json` lists each quality gate by the root script that runs it, and `quality/nfr-manifest.json` holds the response-time, concurrency, and data-volume targets. The template schedules nothing: each team decides when gates run. The production image is built from the `Dockerfile` by `pnpm container:build`. See the [testing guide](testing.md) and the [supply-chain runbook](runbooks/supply-chain.md).

## Template origin

This template was first built inside the Apex repository, under `templates/full-stack-express/`, and is meant to be copied into its own repository. Nothing in it depends on Apex code, packages, or services. While it still sits inside Apex, run every command from the template folder and never run `pnpm install` from the Apex root. After the move, the folder becomes the repository root and every relative path in these documents stays the same.
