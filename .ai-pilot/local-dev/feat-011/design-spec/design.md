# Design — Reference Test Framework

> **PRD slug:** `full-stack-express-starter-template` | **Priority:** Must Have | **Feature flag:** `None`
> **Parent Epic:** Testing, Quality Manifest and Supply Chain | **Affected personas:** QA, Developer
> **Open items:** See [design-doc-assumptions.md](design-doc-assumptions.md) (5 unresolved)

---

## Feature Summary

**Description:** A project built from the Full-Stack Express Starter Template needs proof that it works at every layer, and an agent building from a single prompt needs the same proof. This Feature gives QA and Developer a working test framework with reference tests for units, components, the API, PostgreSQL integration, accessibility journeys, and contract conformance. Coverage floors (80% lines, functions, and statements; 75% branches) fail the run when code falls below them. The end state: one documented command per layer, each exiting zero on a healthy checkout and non-zero with a readable message when a test fails or Docker is missing.

**Feature ID:** FEAT-011 | **Feature depends on:** FEAT-003 (Starter Persistence with `app_users`), FEAT-004 (Zod-Authoritative API Contract), FEAT-006 (Health and Self-Service Profile API), FEAT-010 (Self-Service Profile Screen)

**Work items:**

| ID | Type | Title | Priority |
|----|------|-------|----------|
| TBI-023 | TBI | Set up unit and component tests with coverage thresholds | Must Have |
| TBI-024 | TBI | Set up API and PostgreSQL integration tests | Must Have |
| TBI-025 | TBI | Set up Playwright journeys with axe accessibility checks | Must Have |
| TBI-026 | TBI | Add contract conformance tests from the OpenAPI document | Must Have |
| PBI-022 | PBI | Run the complete reference test suite | Must Have |
| PBI-023 | PBI | See coverage fail below the baseline floors | Must Have |

---

## Scope and Out-of-Scope

**In scope:**
- A Vitest setup with separate `unit` and `component` projects, React Testing Library for components, and V8 coverage with the four floors defined once in shared configuration (TBI-023, PBI-023).
- Reference unit tests for the contracts package, environment configuration, and data-access logic, and reference component tests for every state of the profile screen (TBI-023).
- Supertest API tests for the profile and health endpoints: success, validation failure, unauthenticated, and database-failure paths (TBI-024).
- Testcontainers PostgreSQL integration tests that apply the committed migrations to an empty database and exercise the data-access module and both endpoints, including a check that one principal cannot read or change another's profile (TBI-024).
- A Playwright journey for the profile flow (view, edit, save, failure) with axe checks on every screen state, using the development adapter and the documented selector convention (TBI-025).
- Contract conformance tests that call every route in the committed OpenAPI document and check real responses, including Problem Details errors, against its schemas (TBI-026).
- One documented command per layer, a readable failure report, and a clear "Docker is required" message when Docker is down (PBI-022).
- A coverage command that passes at or above the floors and fails below them, naming the metric (PBI-023).

**Out of scope:**
- CI execution policy, required tiers, and when any suite runs (Feature, PBI-022; BR-013).
- Cross-browser matrices beyond the one reference journey (Feature).
- Load test execution (PBI-022). Load-test tooling belongs to FEAT-012.
- Per-file coverage thresholds and coverage trend reporting (PBI-023).
- The quality manifest, the NFR manifest, and the manifest validator (FEAT-012).
- Pipeline definitions, image publishing, and deployment stages (PRD; Platform Engineering).
- Any change to Apex runtime behavior, its database, its tests, or its services (PRD; BR-008).
- Test data classification, real credentials, and production identity providers (PRD).

---

## Target Surface

**Primary surface:** Full-stack (the framework tests both the server and the client of the template)

**Experience notes:** This Feature adds no screen. QA and Developer use it from a terminal in the template folder, `templates/full-stack-express/`. The Playwright journey drives the existing self-service profile screen (FEAT-010) in a browser. Command output is plain text and machine-readable reports, so it works with screen readers and agents.

---

## Access Control

| Action | Who can perform it | Data scope |
|--------|--------------------|-----------|
| Run unit, component, API, contract, and coverage commands | Developer, QA (anyone with the template checkout; no roles defined) | No restriction (local, synthetic data) |
| Run integration and end-to-end commands | Developer, QA with Docker running locally | No restriction (throwaway container, synthetic data) |
| Use the development identity adapter in the Playwright journey | Local only: authentication mode `development` and non-production environment | User-scoped (one fixed synthetic principal) |
| Call the profile endpoints under test (`GET` and `PUT /api/v1/me`) | Authenticated principal from the identity-provider adapter; no roles defined | User-scoped |
| Call the health endpoints under test (`/health/live`, `/health/ready`) | None | No restriction |
| Review the template in Apex and move it to the bootstrap source | Platform Admin (Platform Engineering) | Global |

The template defines no roles, permissions, or authorization policy (BR-003). The tests assert that protected routes demand authentication and that data stays scoped to the caller. They do not test role checks, because none exist.

**Feature flag:** `None` — rollout: Not applicable
**Behavior when flag is off:** Not applicable. The template ships its own provider-neutral flag interface for generated apps; it is not an Apex Feature Flag and this Feature does not touch it.

---

## Acceptance Criteria

### PBI-022 — Run the complete reference test suite

*As a QA, I want to run unit, component, API, database integration, accessibility, and contract tests with documented commands, so that I can verify a build at every layer from one repository.*

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Docker is running and the workspace is installed | I run each documented test command | Unit, component, API, integration, end-to-end, and contract tests all pass |
| (b) Error/failure | A test fails | I read the output | It names the test, the expected behavior, and the observed behavior |
| (c) Edge case/boundary | Docker is not running | I run the integration tests | They fail with a message that Docker is required, not with a database connection stack trace |
| (d) Negative scenario | A change removes the unauthenticated rejection from a protected route | I run the API tests | At least one test fails |

### PBI-023 — See coverage fail below the baseline floors

*As a Developer, I want to see the coverage check fail when coverage drops below the baseline floors, so that new code is tested before it merges.*

| # | Given | When | Then |
|---|-------|------|------|
| (a) Happy path | Coverage meets all four floors | I run the coverage command | It passes and prints the totals |
| (b) Error/failure | Branch coverage is 74% | I run the coverage command | It fails and names branches as the metric below its floor |
| (c) Edge case/boundary | Branch coverage is exactly 75% and the other metrics are exactly 80% | I run the coverage command | It passes |
| (d) Negative scenario | I lower a threshold in one package's local configuration | I run the quality manifest validator | The validator reports that the package does not use the shared floors |

Scenario (d) needs the manifest validator from FEAT-012. See ⚠ items in [design-doc-assumptions.md](design-doc-assumptions.md).

### Technical work items — definition of done

The backlog gives TBIs a definition of done, not Given/When/Then rows. The tech spec traces each line below to a verification test (VT).

| ID | Definition of done | Verified by |
|----|--------------------|-------------|
| TBI-023 | Reference unit tests cover contracts, configuration, and data-access logic. Reference component tests cover the profile screen states. Coverage fails below 80% lines, functions, or statements, or below 75% branches. One command runs all unit and component tests. Thresholds are defined once in shared configuration. | VT-01, VT-09 to VT-11, VT-13, VT-31 |
| TBI-024 | Integration tests apply committed migrations to an empty containerized database. API tests cover success, validation failure, unauthenticated, and database-failure paths. Tests prove one principal cannot read or change another's profile. One command runs the integration suite. Each run starts from a fresh database. | VT-02, VT-03, VT-15 to VT-23 |
| TBI-025 | A journey views, edits, and saves the profile and checks the failure path. axe checks run on loading, loaded, edit, and error states. Tests use the documented selector convention. One command runs the end-to-end suite. Journeys use synthetic data and stable selectors. | VT-05, VT-24 to VT-27 |
| TBI-026 | Conformance tests cover every route in the committed document. A response that differs from its schema fails the test. Error responses are checked against the Problem Details schema. One command runs the contract tests. | VT-04, VT-28 to VT-30 |

---

## UI/UX

Not applicable. This Feature adds no screen, route, or component. The Playwright journey drives the profile screen that FEAT-010 builds, and it relies on the test selector convention that FEAT-009 (TBI-021) defines. This Feature adds no `data-testid` attributes of its own.

---

## Technical Specification

See [design-doc-tech-spec.md](design-doc-tech-spec.md) for architecture, data contracts, testing strategy, verification test matrix, implementation plan, and diagrams.
