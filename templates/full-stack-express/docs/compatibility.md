# Compatibility

Pinned versions for this workspace. The source is the newest stable release on
the implementation date, except where a peer dependency forces the previous
major. `toolchain:check` fails when this table and `pnpm-workspace.yaml` disagree.

| Component                                    | Pinned version | Source                                            | Installed in                                                                       |
| -------------------------------------------- | -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Node                                         | 24.22.1        | implementation-date latest stable                 | .nvmrc                                                                             |
| pnpm                                         | 10.34.9        | implementation-date latest peer-compatible stable | packageManager                                                                     |
| typescript                                   | 6.0.3          | implementation-date latest peer-compatible stable | apps/api, apps/web, packages/contracts, packages/ui                                |
| eslint                                       | 9.39.5         | implementation-date latest peer-compatible stable | package root, packages/config                                                      |
| @eslint/js                                   | 9.39.5         | implementation-date latest stable                 | packages/config                                                                    |
| typescript-eslint                            | 8.72.1         | implementation-date latest stable                 | packages/config                                                                    |
| eslint-plugin-react-hooks                    | 7.1.1          | implementation-date latest stable                 | packages/config                                                                    |
| eslint-plugin-jsx-a11y                       | 6.10.2         | implementation-date latest stable                 | packages/config                                                                    |
| globals                                      | 17.13.0        | implementation-date latest stable                 | packages/config                                                                    |
| prettier                                     | 3.9.10         | implementation-date latest stable                 | package root, apps/api, packages/contracts                                         |
| vitest                                       | 5.0.5          | implementation-date latest stable                 | package root, apps/api, apps/web, packages/config, packages/contracts, packages/ui |
| vite                                         | 8.3.5          | implementation-date latest stable                 | apps/web                                                                           |
| @vitejs/plugin-react                         | 6.1.2          | implementation-date latest stable                 | apps/web                                                                           |
| react                                        | 19.3.1         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| react-dom                                    | 19.3.1         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @types/react                                 | 19.3.0         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @types/react-dom                             | 19.3.0         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @types/node                                  | 24.19.2        | implementation-date latest stable                 | package root, apps/api, apps/web, packages/contracts, packages/ui                  |
| express                                      | 5.3.0          | implementation-date latest stable                 | apps/api                                                                           |
| @mui/material                                | 9.5.0          | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| drizzle-orm                                  | 0.45.4         | implementation-date latest stable                 | apps/api                                                                           |
| drizzle-kit                                  | 0.31.11        | implementation-date latest stable                 | apps/api                                                                           |
| @playwright/test                             | 1.64.1         | implementation-date latest stable                 | package root, apps/web                                                             |
| @testing-library/react                       | 16.3.3         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| testcontainers                               | 12.2.1         | implementation-date latest stable                 | package root, apps/api                                                             |
| yaml                                         | 2.9.1          | implementation-date latest stable                 | packages/config                                                                    |
| zod                                          | 4.6.7          | implementation-date latest stable                 | apps/api, apps/web, packages/contracts, package root                               |
| pino                                         | 10.4.0         | implementation-date latest stable                 | apps/api                                                                           |
| pino-http                                    | 11.0.0         | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/api                           | 1.10.0         | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/core                          | 3.0.0          | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/resources                     | 3.0.0          | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/sdk-trace                     | 3.0.0          | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/sdk-metrics                   | 3.0.0          | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/context-async-hooks           | 3.0.0          | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/instrumentation               | 0.300.0        | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/instrumentation-http          | 0.300.0        | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/instrumentation-express       | 0.72.0         | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/instrumentation-pg            | 0.77.0         | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/exporter-trace-otlp-proto     | 0.300.0        | implementation-date latest stable                 | apps/api                                                                           |
| @opentelemetry/exporter-metrics-otlp-proto   | 0.300.0        | implementation-date latest stable                 | apps/api                                                                           |
| @types/express                               | 5.0.6          | implementation-date latest stable                 | apps/api                                                                           |
| supertest                                    | 7.3.1          | implementation-date latest stable                 | apps/api                                                                           |
| @types/supertest                             | 7.2.1          | implementation-date latest stable                 | apps/api                                                                           |
| pg                                           | 8.23.1         | implementation-date latest stable                 | apps/api                                                                           |
| @types/pg                                    | 8.23.1         | implementation-date latest stable                 | apps/api                                                                           |
| @readme/openapi-parser                       | 10.0.0         | implementation-date latest stable                 | packages/contracts                                                                 |
| diff                                         | 9.0.0          | implementation-date latest stable                 | packages/contracts                                                                 |
| @emotion/react                               | 11.14.0        | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @emotion/styled                              | 11.14.1        | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| react-router                                 | 8.5.0          | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| react-error-boundary                         | 6.1.6          | implementation-date latest stable                 | packages/ui                                                                        |
| @testing-library/dom                         | 10.4.2         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @testing-library/jest-dom                    | 7.0.1          | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @testing-library/user-event                  | 14.6.8         | implementation-date latest stable                 | apps/web, packages/ui                                                              |
| @tanstack/react-query                        | 5.105.0        | implementation-date latest stable                 | apps/web                                                                           |
| react-hook-form                              | 7.91.0         | implementation-date latest stable                 | apps/web                                                                           |
| @hookform/resolvers                          | 6.0.1          | implementation-date latest stable                 | apps/web                                                                           |
| axe-core                                     | 4.14.0         | implementation-date latest stable                 | apps/web                                                                           |
| jsdom                                        | 30.1.3         | implementation-date latest stable                 | package root, apps/web, packages/ui                                                |
| @vitest/coverage-v8                          | 5.0.5          | implementation-date latest stable                 | package root                                                                       |
| ajv                                          | 8.20.0         | implementation-date latest stable                 | apps/api                                                                           |
| msw                                          | 3.0.3          | implementation-date latest stable                 | apps/web                                                                           |
| @axe-core/playwright                         | 4.14.0         | implementation-date latest stable                 | package root, apps/web                                                             |
| secretlint                                   | 13.1.0         | implementation-date latest stable                 | package root                                                                       |
| @secretlint/secretlint-rule-preset-recommend | 13.1.0         | implementation-date latest stable                 | package root                                                                       |
| @cyclonedx/cdxgen                            | 12.9.0         | implementation-date latest stable                 | package root                                                                       |

## Selection notes

- Node `24.22.1` is the newest Node 24 patch on 2026-10-26. `.nvmrc` records that patch. `engines.node` is `>=24.0.0 <25.0.0`, so another patch on the 24 line passes the guard.
- pnpm `12.15.0` is newer and ships a native executable. pnpm 11 and later start that executable, which Windows group policy blocks on the implementation machine. This workspace pins pnpm `10.34.9`, the newest release that still runs on Node. Corepack checks the hash stored in `packageManager`. Root scripts that recurse call `corepack pnpm` so a different pnpm on `PATH` cannot satisfy them. `corepack enable` needs write access to the Node install directory. When that write is refused, prefix the documented commands with `corepack`.
- TypeScript `7.0.2` is newer. `typescript-eslint` `8.72.1` accepts TypeScript below `6.1.0`, so this workspace pins TypeScript `6.0.3`.
- ESLint `10.13.0` is newer. `eslint-plugin-jsx-a11y` `6.10.2` accepts ESLint through version 9, so this workspace pins ESLint `9.39.5`.
- Rows marked `reserved` are reviewed now and installed by the feature that first imports them. They are absent from the lockfile until then.
- `onlyBuiltDependencies` is empty. pnpm skips dependency lifecycle scripts unless a package is listed there. Add a package only after it needs a build step, and record the reason in this file.
- On pnpm 10.34.9, `engine-strict=true` rejects a Node or pnpm version outside `engines` before dependencies are fetched and before `preinstall`. The install exits with `ERR_PNPM_UNSUPPORTED_ENGINE`, names the expected range and the running version, and does not create `node_modules`. Checked on 2026-10-26 with `engines.node` set to `>=99.0.0 <100.0.0`. The `preinstall` guard still rejects `npm install`, and `pnpm toolchain:check` runs the same script for the catalog and the table.
- A frozen install after a catalog edit fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and leaves `pnpm-lock.yaml` unchanged. The guard's own messages are unchanged.
- `.npmrc` does not set `package-lock=false`. pnpm treats that key as "do not use a lockfile" and then refuses a frozen install. npm still writes `package-lock.json` before `preinstall` returns, so the guard deletes that file when the package manager is not pnpm.
- zod `4.6.7` is the newest Zod 4 release on 2026-10-26. Apex allows `zod ^4.3.6`. This workspace pins the exact release. Schema messages are static strings, so a later Zod 4 release cannot start printing received values.
- yaml `2.9.1` parses `compose.yaml` in the configuration tests.
- `@readme/openapi-parser` `10.0.0` validates the committed OpenAPI document as OpenAPI 3.1 in `openapi:check`. Zod's built-in `z.toJSONSchema` converts the schemas, so no Zod-to-OpenAPI package is installed.
- diff `9.0.0` prints the unified diff when `openapi:check` finds a stale document. It ships its own type declarations, so `@types/diff` is not installed.
- pg `8.23.1` is the driver behind `drizzle-orm/node-postgres`; `@types/pg` `8.23.1` matches it. Only `apps/api/src/persistence/` imports either.
- testcontainers `12.2.1` starts `postgres:16` for the API integration tests and the browser-journey stack. `pnpm test:integration` and `pnpm test:e2e` exit with the Docker message when no runtime answers. `pnpm test` skips those two suites and prints the same reason.
- pnpm reports ignored build scripts for `esbuild` (used by drizzle-kit), and for `ssh2`, `cpu-features`, and `protobufjs` (used by testcontainers). None is needed: esbuild ships its binary as an optional dependency, and the native SSH helpers are optional. `onlyBuiltDependencies` stays empty.
- OpenTelemetry JS 3.0 renamed the trace SDK to `@opentelemetry/sdk-trace`. The OTLP exporters `0.300.0` depend on that package, so this workspace pins the 3.0 line and not `@opentelemetry/sdk-trace-node` `2.12.0`. Every 3.0 package requires `@opentelemetry/api` `>=1.10.0 <1.11.0`.
- The OTLP exporters are the `-otlp-proto` packages because `OTEL_EXPORTER_OTLP_PROTOCOL` accepts only `http/protobuf`. The `-otlp-http` packages send JSON.
- `@opentelemetry/instrumentation-pg` `0.77.0` records the `db.client.operation.duration` histogram, so the data-access module needs no metrics code of its own.
- `@emotion/react` and `@emotion/styled` are the styling peers of `@mui/material` `9.5.0`. `packages/ui` lists them, `react`, `react-dom`, `@mui/material`, and `react-router` as peer dependencies, and `apps/web` installs them.
- `jsdom` `30.1.3` supports Node `^24.15.0`. It is the DOM for `packages/ui` and `apps/web` component tests, together with `@testing-library/dom`, `@testing-library/jest-dom`, and `@testing-library/user-event`.
- `@tanstack/react-query` `5.105.0` is the newest 5.x release and supports React 19. The profile screen keeps server state in it. Mutations do not retry; the profile query turns retries off itself.
- `react-hook-form` `7.91.0` and `@hookform/resolvers` `6.0.1` run the profile form. Resolvers 6 accepts Zod 4, which is the Zod this workspace pins.
- `axe-core` `4.14.0` checks the profile screen in component tests. `@playwright/test` `1.64.1` runs the browser journeys. `@axe-core/playwright` `4.14.0` is the Playwright binding and accepts that Playwright version. `pnpm e2e:install` downloads Chromium. `onlyBuiltDependencies` stays empty, so `pnpm install` does not download browsers.
- `@vitest/coverage-v8` `5.0.5` matches Vitest `5.0.5`. The root coverage command is the only place that reads the shared floors.
- ajv `8.20.0` validates HTTP responses against the committed OpenAPI 3.1 schemas (JSON Schema 2020-12). Zod checks request bodies. It does not check a response against the generated document, so the contract suite uses ajv.
- msw `3.0.3` intercepts profile fetches in the component suite. `graphql`, `typescript`, and `vite` peers are unused here.
- Supply-chain tools are the spec defaults. The organization has not confirmed the approved set. `secretlint` `13.1.0`, `@secretlint/secretlint-rule-preset-recommend` `13.1.0`, and `@cyclonedx/cdxgen` `12.9.0` are catalog rows. OSV-Scanner `2.7.0` is not an npm package, so it is not a catalog row. The scan script downloads that release and checks the checksums in `scripts/supply-chain/osv-scanner.mjs`. The production base image is `node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`, the same digest as `node:24.22.1-bookworm-slim` on 2026-10-27. The digest is not a catalog row.
- `express` `5.3.0` allows `body-parser` `^2.3.0`. The resolved `2.3.0` has advisory GHSA-27r3-jxmh-p828 at CVSS 7.5, which this template treats as high. Root `package.json` overrides `body-parser` to `2.4.0`, the fixed release. The override is not a direct dependency, so it is not a catalog row.
- Vulnerability scans fail on high and critical advisories. An exception in `config/supply-chain/vulnerability-exceptions.json` needs `advisory`, `package`, `reason`, `owner`, `reviewed`, and `expires`. `expires` is the last day the exception is honored.
- Local PostgreSQL uses the image `postgres:16`, the same major version Apex CI runs. The tag is pinned in `compose.yaml`. This table mirrors the pnpm catalog, and the toolchain check rejects a row the catalog does not have, so the image tag is not a catalog row.

## Registry

Dependencies install from the public npm registry. This file records versions, not a git remote. Do not commit a registry token. A consuming repository that uses a private feed adds the feed URL in `.npmrc` and reads the token from the environment.
