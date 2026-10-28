# Testing guide

Every suite runs on Vitest except the browser journeys, which run on Playwright. Run every command from the repository root after `pnpm setup` and `pnpm build`. Each team decides when to run the suites. The template schedules none of them.

## Quality gates

The [quality manifest](../quality/quality-manifest.json) lists each quality gate by the root script that runs it, plus the coverage floors and any deferred gates. The [NFR manifest](../quality/nfr-manifest.json) holds the response-time, concurrency, and data-volume targets. `pnpm quality:validate` checks both files. The [quality guide](../quality/README.md) describes every field, how to record a deferral, and how to run the sample load test.

## Suites

| Command                 | What it runs                                                                    | Where the tests live                                             |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `pnpm test:unit`        | Contract, configuration, data-access, script, and validator tests               | `*.test.ts` across the workspace, `packages/config/`, `scripts/` |
| `pnpm test:component`   | React component tests in jsdom                                                  | `*.test.tsx` in `apps/web/src/` and `packages/ui/src/`           |
| `pnpm test:api`         | HTTP tests against an in-memory store. No Docker                                | `apps/api/test/api/`                                             |
| `pnpm test:contract`    | Every committed operation checked against the OpenAPI document                  | `apps/api/test/contract/`                                        |
| `pnpm test:integration` | PostgreSQL tests with Testcontainers. Needs Docker                              | `apps/api/test/integration/`                                     |
| `pnpm test:e2e`         | Browser journeys. Needs Docker and Chromium                                     | `e2e/specs/`                                                     |
| `pnpm test:a11y`        | The browser run limited to tests tagged `@a11y`                                 | `e2e/specs/`                                                     |
| `pnpm test:coverage`    | Unit, component, and API tests with the coverage floors                         | Same as those suites                                             |
| `pnpm test`             | All of the above in order. Suites that need Docker or Chromium skip and say why | —                                                                |

`pnpm e2e:install` downloads the Chromium build Playwright drives. `pnpm install` does not.

## Coverage floors

Lines, functions, and statements must reach 80%. Branches must reach 75%. The floors live in `packages/config/testing.mjs`, and the quality manifest repeats them; `pnpm quality:validate` fails when the two differ. A member's Vitest config cannot set its own floors.

## Writing tests

- Name each test after the behavior it proves. When a test covers a backlog criterion, put the criterion id in the name so it can be found with a text search.
- Use synthetic data only: `example.test` email addresses and invented names. Fixtures in `apps/api/test/fixtures/synthetic.ts` show the pattern.
- Component and browser tests locate elements by role and accessible name first, then by `data-testid`. A CSS class, element id, or XPath locator in a browser test fails lint. The selector convention is in the [component catalog](component-catalog.md#test-ids).
- A test that needs Docker must skip, and say so in its output, when no Docker runtime answers. Follow the pattern in `scripts/docker-guard.mjs`.
- Build the API test app with `apps/api/test/support/createTestApp.ts` so tests use the same middleware order as production.

## Documentation checks

`pnpm docs:check` reports broken internal links, missing required headings, inline paths that no longer exist, documents missing from the [agent index](agent-index.txt), and workspace members missing from the [module map](module-map.md). Its own tests are in `scripts/check-docs.test.mjs` and run with `pnpm test:unit`.
