# Apex E2E Quality Strategy

## Overview

Apex uses a **risk-based, deterministic quality portfolio** to protect the critical SDLC pipeline (Interview → PRD → Prototype → Design Doc → ADO export) and daily delivery tooling (Calendar, Standup, Planning) without incurring flaky, expensive, or non-deterministic tests.

> To run the tests yourself, see the [E2E command reference](../../tests/e2e/README.md#commands) in `tests/e2e/README.md`.

The portfolio has four layers:

```
                    ┌──────────────────────────────────┐
                    │   E2E (Playwright, ~8 spec files) │  ← critical user journeys
                    ├──────────────────────────────────┤
                    │  Integration (Jest + real PG)     │  ← schema/query contracts
                    ├──────────────────────────────────┤
                    │  API/Route (Jest + Supertest)     │  ← HTTP contracts (mocked)
                    ├──────────────────────────────────┤
                    │  Unit (Jest, ~195 files)          │  ← business rules, hooks
                    └──────────────────────────────────┘
```

## Layer boundaries

| Layer | Purpose | External I/O |
|-------|---------|-------------|
| **Unit** | Business logic, component behaviour, hooks | All mocked |
| **API/Route** | HTTP contracts, auth, RBAC responses | Services mocked |
| **Integration** | Real Drizzle queries, schema constraints, workflow transitions | Live PG (test DB) |
| **E2E** | Cross-page user journeys, navigation gating, UI state machines | ADO/AI/Teams stubbed |

## What does not belong in Playwright

These are either nondeterministic, cost-generating, or better verified at a lower layer:

| Behavior | Correct layer |
|---------|--------------|
| AI/Cursor SDK agent output text | Unit mock of chatAgentService |
| Validation scorecard numeric score | Golden fixture + documentValidationService unit |
| ADO work item content | azureDevOps.ts unit tests |
| Teams notification delivery | teamsBotService unit mock |
| RC/ETL sync timing | MaxView integration tests |
| Azure Entra authentication | Separate redirect-boundary smoke (prod-only, manual) |
| Real SSE event ordering | pgNotifyService integration test |

## Test data management

All E2E test records use the `[E2E]` title prefix. The `/e2e/reset` endpoint (mounted only in `E2E_MODE=true`) deletes them after each test. Records are uniquely identifiable by prefix so cleanup never touches production data.

For CI, a fresh PostgreSQL 16 database (`aipilot_e2e`) is provisioned per workflow run and discarded afterward. Locally, developers use a separate `aipilot_e2e` database (see `tests/e2e/README.md`).

## Authentication approach

Tests use the non-production `/auth/dev-login` endpoint with one of the six synthetic dev personas (`developer`, `ba`, `manager`, `product-owner`, `qa`, `ui-ux`). These personas are seeded by the `20260623150000_seed-dev-mock-users.sql` migration.

Real Azure/Entra authentication is never executed in the **local** Playwright suite. It is tested via the auth route unit tests (`src/server/__tests__/auth.test.ts`) and manually for the enterprise login redirect boundary.

### Environment-targeted smoke (`deployed-smoke`)

Beyond the local seed-driven suite, a small **read-only** `deployed-smoke` project runs against already-deployed environments (dev, staging, prod). It never seeds data or calls `/e2e/*`; the prod-restricted `@prod-safe` subset is strictly non-mutating. Because deployed environments run with `NODE_ENV=production` (so `/auth/dev-login` is gated off), **dev + staging** authenticate via a **fully-automated programmatic Azure AD SSO login** performed each run by a Playwright `setup` project (`tests/e2e/support/auth.setup.ts`) using a dedicated test account (`E2E_TEST_USER` / `E2E_TEST_PASSWORD`); it drives the real Entra login form and writes a fresh, ephemeral `storageState` — no stored/manually-captured session blob. **Production stays unauthenticated** — the `@prod-safe` subset runs with no credentials and no `setup` project. The dedicated test account must be MFA / conditional-access exempt for the environments under test. See the [Environments section of the E2E README](../../tests/e2e/README.md#environments) for the full env matrix, env vars (`E2E_BASE_URL`, `E2E_TEST_USER`, `E2E_TEST_PASSWORD`), the MFA prerequisite, tenant selector tuning, and the CI wiring.

## E2E server isolation

The Express server starts with `E2E_MODE=true` (see `src/server/index.ts`). This flag:
- Is explicitly rejected in `NODE_ENV=production` (hard exit at startup).
- Suppresses all background services: schedulers, recovery loops, reapers, telemetry export, and PostgreSQL notify listeners.
- Routes session files and data files to a temporary OS directory (`AI_PILOT_DATA_DIR`).

The Vite dev server proxies `/api` and `/auth` to Express as in normal development.

## Tier 0 journeys (current milestone)

| Spec | Persona | AC covered |
|------|---------|-----------|
| `auth-project-selection.spec.ts` | all | Login, project entry, shell load |
| `access-control.spec.ts` | developer, ba | Route guards, nav gating, menu settings |
| `interview-dashboard.spec.ts` | ba, developer, manager, product-owner, qa | Dashboard tabs, start-interview eligibility |
| `prd-approval.spec.ts` | ba, qa | Comment blocking, reviewer approve, owner approve |
| `calendar-work-items.spec.ts` | developer | Work item list, details panel, error handling |
| `notifications.spec.ts` | developer, ba | Bell badge, center, mark-read, empty state |
| `ado-export.spec.ts` | ba | Export button gating, modal, success, failure |
| `a11y.spec.ts` | developer, ba | WCAG 2.1 Level A/AA critical/serious violations |

## Tier 1 journeys (next milestone)

Design docs, prototypes, standups, feature requests, platform admin (menu toggle), planning permissions, Dev Workbench, super-admin browser behavior.

## Quality targets

These are measurement targets — not hard gates — until three CI baseline runs establish realistic benchmarks:

| Metric | Target |
|--------|--------|
| Smoke suite reliability | ≥ 99% |
| Flake rate (fail → pass on retry) | ≤ 2% |
| PR E2E duration | ≤ 15 minutes |
| Quarantine age (max open) | 14 days |
| WCAG critical/serious violations | 0 |
| Tier 0 AC traceability coverage | 100% |

## Ownership

| Area | Owner |
|------|-------|
| E2E spec files | QA (feature author for new scenarios) |
| Page objects | Engineering |
| Fixture/seed infrastructure | Platform / DevEx |
| CI pipeline | Platform / DevEx |
| Cursor triage script | Platform / DevEx |
| Quarantine register | QA lead |
| Quality metrics | QA lead |

## Traceability

Each spec file opens with an `AC:` comment naming the acceptance criterion group it covers. Tests are tagged with `@smoke`, `@critical`, `@regression`, or `@a11y`. Future work will link test IDs to Apex-generated test cases (`test_cases` table) via the `// test-case-id: TC-PBI-xxx-xxx` comment convention.

## Cursor SDK maintenance automation

`scripts/e2e/cursor-triage.ts` uses the Cursor Enterprise SDK to classify failed tests after a Playwright run. Classification options are: `product_defect`, `test_defect`, `environment_issue`, `probable_flake`. The script:
- Reads failed test metadata from the JUnit XML artifact.
- Calls a Cursor agent via `Agent.prompt(...)` for structured analysis.
- Writes a `cursor-triage-report.json` report to the results directory.
- **Exits 0 regardless** — it is informational and cannot change CI outcome.
- Agent-authored fix suggestions require human review and a separate PR.

**Prerequisite:** Verify Cursor Enterprise service-account entitlement and the `CURSOR_API_KEY` GitHub secret before enabling the triage workflow in CI.
