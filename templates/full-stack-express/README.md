# project-name

Self-contained pnpm workspace for a React web client and an Express API. It has its own lockfile, toolchain, and lint rules. It does not join the host repository's install, build, or test commands.

Run every command in this README from `templates/full-stack-express/` while this folder sits inside the Apex repository. Do not run `pnpm install` from the Apex root. That writes a lockfile beside the host project and breaks this workspace's isolation. After the folder is copied into its own repository, run the same commands from the directory that contains this README.

Node 25 and later do not bundle Corepack. This workspace stays on the Node 24 line, which does bundle it. On Node 25 or later, install Corepack with `npm install -g corepack` before `corepack enable`.

## Clean checkout

1. Install Node 24. The patch in `.nvmrc` is 24.22.1. The guard accepts any patch on the 24 line, then enable Corepack.
   Working directory: `templates/full-stack-express/`.

   ```sh
   corepack enable
   ```

   If that command cannot write to the Node install directory, leave the shims unchanged and prefix later commands with `corepack`. For example, `corepack pnpm install --frozen-lockfile`. Root scripts that call pnpm already go through Corepack.

2. Install the locked dependencies. The install is frozen: it refuses to change the lockfile.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Build all five workspace members. The web client and the API write separate `dist/` directories.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm build
   ```

4. Type-check every member. Run this after the build. The contracts and UI packages are imported from `dist/`.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm typecheck
   ```

5. Lint every member from the workspace root.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm lint
   ```

6. Check formatting.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm format:check
   ```

7. Check the pinned toolchain, the compatibility table, dependency specs, and shared TypeScript config.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm toolchain:check
   ```

8. Run the workspace tests. Run this after the build.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm test
   ```

9. Run the static checks together.
   Working directory: `templates/full-stack-express/`.

   ```sh
   pnpm check
   ```

## Local stack

Copy the example environment file, install, start PostgreSQL, then start the API and the web client.
Working directory: `templates/full-stack-express/`.

```sh
cp .env.example .env
pnpm setup
pnpm db:up
pnpm dev
```

On Windows PowerShell, copy the file with `Copy-Item .env.example .env`.

`pnpm db:up` starts PostgreSQL and waits until it accepts connections. `pnpm db:down` stops it. The data volume stays. `pnpm dev` runs the API and the web client. The API reads `.env` when that file exists. A missing or invalid value stops the API before it listens and names every bad variable. The message never prints a value.

After `pnpm db:up`, run `pnpm migrate` to create the tables and `pnpm seed` to load synthetic rows. Both read `NODE_ENV` and `DATABASE_URL` from `.env`. `pnpm migrate` is also the command Platform Engineering runs before traffic switches. The API never changes the schema when it starts.

## Database and migrations

The starter's one table is `app_users`, defined in `apps/api/src/persistence/schema.ts`. Only `apps/api/src/persistence/` may import Drizzle or the `pg` driver; ESLint enforces that. Change the schema, run `pnpm db:generate -- --name <slug>`, check with `pnpm migrate:validate`, and commit the schema and the generated SQL together. Ownership, exit codes, and the forward-only rollback policy are in [docs/runbooks/migrations.md](docs/runbooks/migrations.md).

Tests that need PostgreSQL start it with Testcontainers. They skip, and say so in the test name, when Docker is not available.

## Change the PostgreSQL port

Docker Compose reports the failure when the host port is already in use. Node's env-file loader does not expand variables, so change both of these in `.env` and keep them equal:

- `POSTGRES_PORT`
- the port inside `DATABASE_URL`

`DATABASE_URL` in the example file uses port `5432`, the same value as `POSTGRES_PORT`. The database is published on `127.0.0.1` only.

To format files, run `pnpm format` from `templates/full-stack-express/`.

## Identity

Every route under `/api/v1` requires an authenticated principal. `AUTH_MODE` picks the identity adapter and has no default.

| `AUTH_MODE`   | Adapter                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `development` | Every request runs as one synthetic principal. Startup stops if `NODE_ENV` is `production`  |
| `external`    | The adapter registered in `apps/api/src/identity/registry.ts`. None ships with the template |

The routes, response shapes, error types, probes, and HTTP settings are in [apps/api/README.md](apps/api/README.md).

A request the adapter does not authenticate gets a `401` Problem Details response. The template defines no roles or permissions. The contract, the steps to add a production identity provider, and where RBAC would attach are in [apps/api/src/identity/README.md](apps/api/src/identity/README.md).

## Feature flags

The API gates new behavior through `FlagEvaluator` in `apps/api/src/feature-flags/`. The local adapter reads one optional variable.

| Variable        | Required | Format                                                       |
| --------------- | -------- | ------------------------------------------------------------ |
| `FEATURE_FLAGS` | No       | JSON object of kebab-case flag names to booleans, e.g. `{}`. |

In `.env`, wrap a non-empty value in single quotes: `FEATURE_FLAGS='{"checkout-v2":true}'`. The API reads the value once at start-up, so a change needs a restart. An unset or empty value defines no flags. An invalid value is ignored as a whole: the API still starts, logs one `feature_flags.config_invalid` warning that never includes the value, and every flag returns its default. Check the JSON locally when that warning appears.

Read a flag once at the top of a handler or service entry point, declare the default there, and branch once. Keep the name and default in one constant when more than one place reads the flag.

```ts
const CHECKOUT_V2 = { name: 'checkout-v2', defaultValue: false } as const;

if (flags.isEnabled(CHECKOUT_V2.name, CHECKOUT_V2.defaultValue)) {
  // new behavior
} else {
  // existing behavior
}
```

`isEnabled` is synchronous, never throws, and never reads request input. Do not gate authentication, authorization, or the development identity guard behind a flag. Flags switch new product behavior only.

The flag provider is an open decision. The extension point is the `createLocalFlagEvaluator` call in the API entry point. To adopt a provider, write an adapter that implements `FlagEvaluator` from an in-memory cache and replace that one call. Call sites do not change.

## Scripts

| Script             | What it does                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `preinstall`       | Runs the toolchain guard before any dependency is fetched                                                                |
| `setup`            | Installs from the lockfile. This is the install step                                                                     |
| `build`            | Builds members in dependency order through Corepack. The config package has no build                                     |
| `check`            | Runs typecheck, lint, format:check, openapi:check, and routes:check                                                      |
| `routes:check`     | Fails when the API's registered routes and the contract routes differ                                                    |
| `typecheck`        | Type-checks every member that defines the script                                                                         |
| `lint`             | Lints the whole workspace once                                                                                           |
| `format`           | Rewrites files with Prettier                                                                                             |
| `format:check`     | Fails when a file disagrees with Prettier                                                                                |
| `test`             | Runs unit, component, API, and contract tests, then integration and browser tests when Docker and Chromium are available |
| `dev`              | Runs the API and the web client with file watching. This is the local run step                                           |
| `migrate`          | Applies pending SQL migrations. Exits 0 on success, 1 on a failed migration, 2 on bad configuration                      |
| `seed`             | Inserts synthetic `app_users` rows into a local database. Refuses when `NODE_ENV` is production                          |
| `db:generate`      | Generates a SQL migration from the Drizzle schema. Pass `-- --name <slug>`                                               |
| `migrate:validate` | Fails when the Drizzle schema and the committed migrations disagree. Needs no database                                   |
| `db:up`            | Starts local PostgreSQL and waits until it is healthy                                                                    |
| `db:down`          | Stops local PostgreSQL. The data volume stays                                                                            |
| `toolchain:check`  | Compares the catalog, the compatibility table, manifests, and `tsconfig.json` extends                                    |

## Testing

Working directory: `templates/full-stack-express/`. Install the workspace first. Each team decides when to run the suites. This template does not schedule them.

| Command            | What it runs                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`             | Unit, component, API, and contract tests. Integration and browser tests run only when Docker (and, for the browser, Chromium) is available. A missing runtime skips that suite and prints the reason. Toolchain guard tests run last. |
| `test:unit`        | Contract, configuration, and data-access tests                                                                                                                                                                                        |
| `test:component`   | Profile screen tests in jsdom                                                                                                                                                                                                         |
| `test:api`         | HTTP tests against an in-memory store. No Docker                                                                                                                                                                                      |
| `test:contract`    | Every committed operation checked against `openapi.json`                                                                                                                                                                              |
| `test:coverage`    | Unit, component, and API tests with the shared coverage floors                                                                                                                                                                        |
| `test:integration` | PostgreSQL tests. Needs Docker. Exits with the Docker message when no runtime answers                                                                                                                                                 |
| `test:e2e`         | Browser journeys. Needs Docker and Chromium. Builds the workspace, then starts the stack                                                                                                                                              |
| `test:a11y`        | The same browser run, limited to tests tagged `@a11y`                                                                                                                                                                                 |
| `e2e:install`      | Downloads the Chromium build Playwright drives. `pnpm install` does not                                                                                                                                                               |

`pnpm test:coverage` fails when lines, functions, or statements are below 80%, or branches are below 75%. Those floors live in `packages/config/testing.mjs`. A package Vitest config cannot set its own.

Browser tests locate elements by role, label, or `data-testid`. A CSS class, an element id, or an XPath locator fails lint.

## API contract

Routes are defined once in Zod in `packages/contracts`. The committed `packages/contracts/openapi/openapi.json` is generated from them. The conventions for a new endpoint are in `packages/contracts/README.md`.

- `pnpm openapi:generate` rewrites the committed OpenAPI document from the route definitions.
- `pnpm openapi:check` exits 1 with a unified diff when the committed document is stale, and exits 1 when it is not valid OpenAPI 3.1. `pnpm check` runs it.

After replacing `project-name`, run `pnpm openapi:generate`, because the token appears in the document title.

The web and API builds do not read each other's output.

Build the API and the packages it depends on.
Working directory: `templates/full-stack-express/`.

```sh
pnpm --filter @project-scope/api... build
```

Build the web client and the packages it depends on.
Working directory: `templates/full-stack-express/`.

```sh
pnpm --filter @project-scope/web... build
```

The first command writes `apps/api/dist` and `packages/contracts/dist`. The second writes `apps/web/dist`, `packages/ui/dist`, and `packages/contracts/dist`.

## Logs, traces, and shutdown

The API writes one JSON log line per event to stdout. Each line inside a request carries `requestId`, `correlationId`, and, when tracing is on, `trace_id` and `span_id`. Credentials, tokens, cookies, and identity fields log as `[Redacted]`.

Start the API with the instrumentation entry loaded first, or Express and PostgreSQL spans are lost:

```sh
node --import ./dist/instrument.js dist/index.js
```

In a container, run `node` as the entry command. Do not start it through `pnpm` or a shell, because they do not pass `SIGTERM` to Node.

`apps/api/src/app.ts` mounts the middleware in this order: `requestId()`, `requestLogging(logger)`, the in-flight registry, the routes, then the Problem Details handler. `apps/api/src/index.ts` wires `createShutdown` with the server, the in-flight registry, the database as a closable resource, `telemetry`, and `logger`, then calls `registerSignalHandlers`. The readiness route returns 503 while the process shuts down.

On `SIGTERM` or `SIGINT` the API stops accepting connections and lets running requests finish. Within `SHUTDOWN_TIMEOUT_MS` it closes the database, flushes telemetry and logs, and exits 0. It exits 1 when requests were still running at the deadline, a cleanup step failed, or a second signal arrived.

| Variable                      | Meaning                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `LOG_LEVEL`                   | Lowest level written                                                 |
| `SHUTDOWN_TIMEOUT_MS`         | Total shutdown budget. Keep it below the platform's grace period     |
| `OTEL_SDK_DISABLED`           | `true` turns tracing and metrics off                                 |
| `OTEL_SERVICE_NAME`           | `service.name` on every span and metric                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL. Empty means nothing is exported                  |
| `OTEL_EXPORTER_OTLP_HEADERS`  | `key=value` pairs sent to the collector. Treated as a secret         |
| `OTEL_TRACES_EXPORTER`        | `otlp`, `console`, or `none`. `OTEL_METRICS_EXPORTER` works the same |

## Package source

Packages download from the public npm registry. That registry is not the git remote where a new product repository will live. `.npmrc` has no registry URL and no token. A product that uses a private feed adds the feed URL locally and reads the token from the environment. Do not commit the token.

## Replacement placeholders

Search for each token and replace it by hand. There is no generator. The workspace builds before any token is replaced.

| Token             | Meaning                              | Occurs in                                                                                  |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `project-name`    | Human-readable name                  | Root `package.json` description, README, OpenAPI `info.title`                              |
| `@project-scope`  | npm scope of every workspace package | All `package.json` names, `workspace:*` dependencies, TypeScript `extends`, source imports |
| `project-service` | Service name                         | README. Later environment and observability settings                                       |
| `project_db`      | Database name                        | README, `compose.yaml`, `.env.example`                                                     |

## When a command fails

The frozen install is out of date. A catalog change prints `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and names the catalog. Other manifest drift prints `ERR_PNPM_OUTDATED_LOCKFILE`. Neither command changes the lockfile. From `templates/full-stack-express/`, run `pnpm install`, review the lockfile diff, and commit `pnpm-lock.yaml`.

```text
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
```

The package manager is not pnpm. The guard prints:

```text
check-toolchain: this workspace uses pnpm. Run "corepack enable", then "pnpm install --frozen-lockfile" from the workspace root.
```

Enable Corepack, then repeat the frozen install from `templates/full-stack-express/`. Do not use `npm install`. The guard deletes `package-lock.json` if npm already wrote one, and it does not leave `node_modules`.

The pnpm version does not match `packageManager`. pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE` and the expected version `10.34.9` before it fetches packages. Run `corepack enable`, or invoke `corepack pnpm`, so Corepack selects pnpm 10.34.9, then retry from `templates/full-stack-express/`. When the guard itself runs, it prints:

```text
check-toolchain: pnpm <actual> does not match the pinned pnpm 10.34.9 (packageManager in package.json). Run "corepack enable" and retry.
```

`<actual>` is the pnpm version that started the command.

Node is outside the 24 line. pnpm prints `ERR_PNPM_UNSUPPORTED_ENGINE`, the expected range `>=24.0.0 <25.0.0`, and the running version. Nothing is installed. Install 24.22.1 from `.nvmrc`, or any other Node 24 patch, and retry. When the guard itself runs, it prints:

```text
check-toolchain: Node <actual> is outside the supported range >=24.0.0 <25.0.0 (engines.node in package.json). Install the version in .nvmrc and retry.
```

`<actual>` is the running Node version.
