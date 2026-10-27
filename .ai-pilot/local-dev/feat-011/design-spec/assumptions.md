# Assumptions & Unresolved Items — Reference Test Framework

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> Shared between [design-doc-design.md](design-doc-design.md) and [design-doc-tech-spec.md](design-doc-tech-spec.md).
> Resolve all ⚠ items before implementation begins.

**Feature:** FEAT-011 — Reference Test Framework
**Parent Epic:** Testing, Quality Manifest and Supply Chain
**Run mode:** Non-interactive. The Phase 2 question session did not run, so every question below carries a default. The design uses that default until a person overrides it.

---

## Unresolved Items

Items that the PRD, the backlog, and the Apex checkout could not settle. Each needs a decision before the step it names starts.

- ⚠ **Contract conformance has no gate in the quality manifest**: TBI-027 (FEAT-012) lists twelve gates: build, type-check, lint, formatting, OpenAPI drift, migration validation, unit, component, API, integration, accessibility, and container build. None is `contract`, yet PBI-022 requires a separate contract command and TBI-026 ships one. Without a gate entry, a Platform Admin pipeline built from the manifest never runs `test:contract`, and the manifest validator never checks that the script exists. **Decision needed:** add a `contract` gate to TBI-027 (recommended), or state that the `api` gate runs the contract suite as well. This Feature ships `test:contract` as its own script until the owner of FEAT-012 decides. Blocks S9 (script surface) and the FEAT-012 manifest work.

- ⚠ **PBI-023 (d) cannot pass inside this Feature**: the scenario "I lower a threshold in one package's local configuration → the validator reports that the package does not use the shared floors" needs the manifest validator (TBI-029). TBI-029 sits in FEAT-012, and FEAT-012 depends on FEAT-011, so the validator cannot exist when this Feature ships. This Feature closes the gap partly with VT-13, a static scan that fails when any Vitest config other than the shared module sets a `thresholds` key. VT-12 (the validator check) stays open until TBI-029 lands. **Decision needed:** confirm that VT-13 is the in-Feature acceptance evidence for PBI-023 (d) and that VT-12 runs as part of FEAT-012. Blocks the PBI-023 sign-off.

- ⚠ **Two test libraries sit outside the backlog's tool list, and no approved-version list is visible**: the backlog names Vitest, React Testing Library, Supertest, Testcontainers, Playwright, and axe. The design adds `msw` (to answer HTTP calls in component tests at the network edge) and `ajv` with its 2020-12 dialect (to check responses against the committed OpenAPI 3.1 schemas). The PRD says implementation picks tools from the organization-approved set, but that list is not in the checkout. **Decision needed:** confirm that `msw`, `ajv`, and the pinned versions of all eight libraries are on the approved list. If `ajv` is not approved, TBI-026 needs another JSON Schema validator. Zod cannot replace it, because Zod is the source that generated the document, and the test must check the document itself. If `msw` is not approved, component tests need a `fetch` stub injected into the typed API client, which the TBI-022 client must then allow. Blocks S3 and S7.

- ⚠ **Create-on-first-access is unconfirmed**: the PRD asks maintainers to confirm that `GET /api/v1/me` inserts the `app_users` row on a principal's first request. TBI-015 builds it that way. VT-20, VT-21, and the Playwright journey (VT-24) all start from a principal with no row and rely on that insert. If maintainers reverse the rule, the journey must seed the development principal's row through the seed command, and the integration tests must insert rows directly. **Decision needed:** confirm the behavior before S6 and S8 start.

- ⚠ **Apex root formatting check versus the template's test files**: the PRD says the template must pass Apex's root `prettier --check .` (printWidth 80, single quotes, `es5` trailing commas) or gain a minimal ignore entry, and it asks which. This Feature adds the largest share of TypeScript in the template (specs, fixtures, harness code), so it feels the choice most. **Decision needed:** conform (assumed here) or add an ignore entry for `templates/full-stack-express/`. Settle it in TBI-001 (FEAT-001) before any test file lands. Generated folders (`coverage/`, `playwright-report/`, `test-results/`) never reach a clean checkout, because the template's `.gitignore` lists them.

---

## Assumptions Accepted

Inferences treated as resolved. Confirm with stakeholders before implementation locks.

- **Workspace layout**: the template uses `apps/api`, `apps/web`, `packages/contracts`, `packages/ui`, and `packages/config`, with a template-root `e2e/` folder and a template-root `scripts/` folder. Derived from the five members named in TBI-001; the backlog gives no folder names. Risk: if TBI-001 picks other names, only paths in this design change.

- **Test layers map to separate Vitest projects and scripts**: `unit` (Node, `*.test.ts`), `component` (jsdom, `*.test.tsx`), `api`, `integration`, and `contract`, plus Playwright for end-to-end. The scripts are `test:unit`, `test:component`, `test:coverage`, `test:api`, `test:integration`, `test:contract`, `test:e2e`, `test:a11y`, and an aggregate `test`. Derived from the manifest gate list (unit, component, API, integration, accessibility are separate gates) and from the "single command per suite" lines in TBI-023 to TBI-026. Risk: TBI-005 (FEAT-002) fixes the script surface; names must match whatever it ships.

- **API tests run without Docker; integration tests run with it**: API tests (Supertest) use an in-memory store that implements the data-access interface, so success, validation, unauthenticated, and database-failure paths run in seconds. Integration tests use a real PostgreSQL container. Derived from PBI-022 (c), which says only the integration tests must report a Docker requirement, and from the "observable behavior" rule in the PRD. Risk: a fake can drift from the real store. VT-20 and VT-21 run the same profile scenarios against real PostgreSQL to catch drift.

- **Contract tests use the API test harness, not Docker**: TBI-026 depends on TBI-024's API test harness, and forced error responses (401, validation, 500, not-ready) are easier to trigger through the in-memory store. Risk: a response shape that only real PostgreSQL produces goes unchecked. The integration suite covers those shapes.

- **Coverage runs over unit, component, and API projects**: `test:coverage` merges the three Docker-free projects into one report and applies the floors to the total. Integration and contract runs add no coverage. Derived from BR-012 and TBI-023 ("a single command"). Risk: if API tests are left out, handler code looks uncovered and 80% becomes hard to reach.

- **Coverage scope**: coverage counts `src/**` of `apps/api`, `apps/web`, `packages/contracts`, and `packages/ui`. It excludes test files, `*.d.ts`, generated client and OpenAPI output, Drizzle migration SQL, the seed script, and config files. Risk: a wider scope lowers the totals; a narrower scope hides untested code. The exclude list lives in the shared config and appears in the README.

- **Floors live in one module**: `packages/config` exports `coverageFloors` (`lines 80`, `functions 80`, `statements 80`, `branches 75`) and the root `vitest.config.ts` is the only file that reads it into `coverage.thresholds`. Per-file thresholds stay out of scope (PBI-023 `outOfScope`).

- **Docker detection uses the container runtime client**: the guard asks the Testcontainers runtime client for a connection, so it honors `DOCKER_HOST`, rootless sockets, and Docker alternatives. It does not shell out to a `docker` binary. Risk: an unusual runtime that Testcontainers cannot reach reports "Docker is required" even though a CLI works. The message names the override variable.

- **End-to-end runs use built artifacts**: Playwright starts one Node process (the built API serving the built web client, as the production container will) against a Testcontainers PostgreSQL. This matches the container shape and needs no Vite proxy. Risk: `test:e2e` must build first, which adds time. Derived from the PRD assumption that Express serves the web client.

- **Playwright config cannot start the database itself**: Playwright launches `webServer` before `globalSetup`, so the container must start inside a launcher script (`e2e/support/start-stack.mjs`) that Playwright runs as the `webServer` command. The script starts PostgreSQL, applies migrations, then starts the API.

- **Fault injection uses Playwright route interception**: the journey forces loading, load-error, save-error, and unauthenticated states by intercepting `/api/v1/me`. It does not add test-only endpoints or a switch in the application. Risk: interception proves the screen's reaction, not the API's. API and integration tests prove the API side.

- **axe fails on any violation**: the helper scans with the `wcag2a`, `wcag2aa`, and `wcag21aa` tags and fails on every violation. Apex's own `tests/e2e/specs/a11y.spec.ts` fails only on `critical` and `serious`. The template is stricter because PBI-021 (d) says the gate fails on any reported violation and the PRD says "no violations" on the reference screen. Risk: a library upgrade adds a rule and fails a clean screen. The compatibility table pins `@axe-core/playwright`.

- **axe covers more states than TBI-025 lists**: TBI-025 names loading, loaded, edit, and error. The design also scans the empty-email state, validation errors, save failure, and unauthenticated state, because PBI-022's security note says axe "cover[s] every state of the reference screen" and PBI-019 to PBI-021 define those states.

- **Playwright browsers install by explicit script**: `pnpm e2e:install` downloads Chromium at the pinned Playwright version. `pnpm install` never does, which honors PBI-001's rule that no install-time script fetches unpinned code. Only Chromium runs; cross-browser matrices are out of scope.

- **Playwright run policy stays neutral**: `forbidOnly` is always on, `retries` is `0`, `workers` is `1`, traces and screenshots are kept on failure. The config reads no `CI` variable, because BR-013 leaves run policy to each team. Apex's config sets retries from `CI`; the template does not copy that.

- **Test identity adapter lives in test code**: integration and API tests pick a principal from an `x-test-subject` request header through an adapter defined in `apps/api/test/support/`. The adapter is not exported from `src/`, so no production path can load it. The development adapter (BR-002) serves the Playwright journey only.

- **Synthetic data rule**: every fixture email ends in `@example.test` and every subject and name carries a `test-` prefix. VT-31 scans fixtures and artifacts for anything else. Derived from BR-007. Risk: none beyond a stricter fixture rule.

- **Status codes come from the contract**: this design names 401 for unauthenticated and 500 for unhandled failure. Validation and not-ready codes come from the contracts package (FEAT-004); the tests read them from the committed OpenAPI document instead of hard-coding numbers.

- **Mutation check is a meta test, not a mutation tool**: VT-08 reruns the API suite with a Vitest alias that swaps the authentication middleware for a pass-through, then expects at least one failure. It adds no mutation-testing dependency. Risk: it covers one mutation (the one PBI-022 (d) names), not the whole guard.

- **Tests document, not schedule**: the README's Testing section lists commands and prerequisites and states that each team decides when to run them (BR-013). The testing guidance document in FEAT-014 reuses that section.
