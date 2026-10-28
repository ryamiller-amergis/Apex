# Quality and NFR manifests

Two JSON files describe this repository to a pipeline, a developer, or an agent. Read them in any editor. Nothing needs to run first.

| File                                   | What it holds                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `quality/quality-manifest.json`        | Each quality gate and the root script that runs it, coverage floors, and deferrals |
| `quality/quality-manifest.schema.json` | JSON Schema (draft 2020-12) for the quality manifest                               |
| `quality/nfr-manifest.json`            | Response-time, concurrency, and data-volume targets                                |
| `quality/nfr-manifest.schema.json`     | JSON Schema (draft 2020-12) for the NFR manifest                                   |
| `quality/load-test/profile-read.k6.js` | Sample k6 load test that reads its targets from the NFR manifest                   |

Each team decides when gates and load tests run. The manifests define no tiers, schedules, triggers, or pull-request policy, and the schema rejects a `tier`, `schedule`, `runOn`, or `trigger` key.

## Commands

Working directory: `templates/full-stack-express/`.

| Command                 | What it does                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm quality:validate` | Checks both manifests. Exits 1 and names each problem when one is found. Warnings do not change the exit code  |
| `pnpm loadtest:run`     | Runs the sample load test against `LOAD_TEST_BASE_URL` and prints `PASS`, `FAIL`, or `NOT MEASURED` per target |
| `pnpm test:quality`     | Runs the tests for the validator and the load-test runner                                                      |

## Quality manifest

| Field                | Rule                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`      | `1`. Raised when a field is removed or renamed                                                               |
| `coverage`           | `lines`, `functions`, `statements`, `branches`. Must equal `coverageFloors` in `packages/config/testing.mjs` |
| `gates[].id`         | Kebab-case and unique                                                                                        |
| `gates[].title`      | Short description                                                                                            |
| `gates[].script`     | A script in the root `package.json`. Run it with `pnpm run <script>`                                         |
| `deferrals[].gate`   | Id of a gate in `gates`                                                                                      |
| `deferrals[].reason` | Why the gate cannot run yet. Must not be blank                                                               |
| `deferrals[].owner`  | Person or team that will bring the gate back. Must not be blank                                              |

The validator requires these 12 gate ids. Other kebab-case ids are allowed. The committed manifest also includes `docs-validation`, which runs `docs:check`.

| Gate                   | Script             |
| ---------------------- | ------------------ |
| `build`                | `build`            |
| `type-check`           | `typecheck`        |
| `lint`                 | `lint`             |
| `formatting`           | `format:check`     |
| `openapi-drift`        | `openapi:check`    |
| `migration-validation` | `migrate:validate` |
| `unit`                 | `test:unit`        |
| `component`            | `test:component`   |
| `api`                  | `test:api`         |
| `integration`          | `test:integration` |
| `accessibility`        | `test:a11y`        |
| `container-build`      | `container:build`  |

Each script exits 0 on success and non-zero on failure. A gate script reads secrets only from environment variables and never prints them.

These root scripts exist but are not gates in the committed manifest: `test:contract`, `test:coverage`, `test:e2e`, `routes:check`, `scan:secrets`, `scan:vulns`, `scan:licenses`, `scan`, `sbom`, and `test:container`. To make one a gate, add an entry to `gates`. The schema does not change.

### Record a deferral

When a gate cannot run yet, add an entry to `deferrals` in the same pull request:

```json
{
  "gate": "container-build",
  "reason": "Docker is not available on the build agent yet",
  "owner": "platform-engineering"
}
```

The validator then reports the gate as `deferred` with its owner and reason. If the gate's script is missing, that becomes a warning instead of an error. A deferral with a blank reason or owner, a deferral for an unknown gate, or two deferrals for one gate fail validation. Do not put secrets in deferral text.

The validator never runs a gate. It shows each gate as `defined` or `deferred`, never as passed.

## NFR manifest

The committed values are illustrative examples that show the format. They are not production promises. Each project sets its own targets and sets `illustrative` to `false`. Until then, `quality:validate` warns that the project has not set real targets.

| Target         | Fields                | Illustrative value       | Pass when                                                         |
| -------------- | --------------------- | ------------------------ | ----------------------------------------------------------------- |
| `responseTime` | `percentile`, `maxMs` | P95 at most 500 ms       | The measured percentile is at most `maxMs`                        |
| `concurrency`  | `users`               | 50 users                 | The run held at least `users` virtual users and no request failed |
| `dataVolume`   | `table`, `rows`       | 100,000 `app_users` rows | The table holds at least `rows` rows                              |

Every target also needs `illustrative` (boolean) and `verifiedBy`, the path of the load-test definition that checks it. The validator fails when that file does not exist, and prints a trace table of target, value, and definition.

### Run the load test

The load-test tool is k6, run from the `grafana/k6` image pinned in `scripts/quality/lib/load-test.mjs`, so Docker must be running. The sample calls `GET /api/v1/me` with synthetic data only.

| Variable                     | Required        | Use                                                                                       |
| ---------------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `LOAD_TEST_BASE_URL`         | Yes. No default | Base URL of the environment the team chose. The runner prints it before the first request |
| `LOAD_TEST_AUTH_HEADER`      | No              | `Authorization` header value when the API is not in `development` mode. Never printed     |
| `LOAD_TEST_DATABASE_URL`     | No              | Read-only connection for the data-volume count. Unset means `NOT MEASURED`. Never printed |
| `LOAD_TEST_DURATION_SECONDS` | No. Default 30  | Length of the run                                                                         |

The runner validates both manifests first and stops on an error. It checks `/health/live` on the target, runs k6, counts rows in the data-volume table when `LOAD_TEST_DATABASE_URL` is set, and prints a verdict per target. It exits 0 only when all three are `PASS`. It exits 2 when it cannot run, for example when `LOAD_TEST_BASE_URL` is unset or Docker is not available.

A `localhost` or `127.0.0.1` target is reached from the container as `host.docker.internal`. If the API sets `RATE_LIMIT_MAX`, raise it for the run, or rejected requests fail the concurrency target.
