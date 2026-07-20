# Apex E2E Tests

Playwright browser tests for the Apex web application.

## Quick start

The team's shell is **Windows PowerShell** — examples below use PowerShell. One-time, then run the smoke suite:

```powershell
# One-time: install the Chromium browser Playwright drives
npm run playwright:install

# One-time: create the aipilot_e2e sibling database (see Prerequisites)
npm run test:e2e:create-db

# Run the Tier 0 @smoke journeys (fast, headless)
npm run test:e2e:smoke
```

Playwright starts and stops its own servers (Express on 3001 in `E2E_MODE`, Vite on 3000), so you don't need `npm run dev` running — in fact you should **stop** it first (see Prerequisites).

## Commands

Every command below maps to a real `package.json` script or a valid `npx playwright` invocation. Run them from the repo root.

| Command | What it does |
|---------|--------------|
| `npm run playwright:install` | One-time: installs the Chromium browser (`playwright install chromium --with-deps`). |
| `npm run test:e2e:create-db` | One-time: creates the `aipilot_e2e` sibling database via the `pg` module (no `psql`/`createdb` needed). Safe to re-run — no-op if it already exists. |
| `npm run test:e2e:smoke` | Runs only the Tier 0 `@smoke` journeys (`playwright test --grep @smoke`). Fastest signal. |
| `npm run test:e2e` | Runs the full suite (`playwright test`). |
| `npm run test:e2e:headed` | Runs the full suite in a visible browser window (`playwright test --headed`). |
| `npm run test:e2e:ui` | Opens Playwright's interactive UI mode for stepping through and re-running tests (`playwright test --ui`). |
| `npm run test:e2e:a11y` | Runs only the accessibility scans (`playwright test --grep @a11y`). |
| `npm run test:e2e:reset-db` | Cleans up leftover `[E2E]`-prefixed rows after an interrupted run (Ctrl-C). |

### Raw Playwright usage (no npm script)

For these, call `npx playwright` directly:

```powershell
# Run a single spec by filename fragment
npx playwright test calendar-work-items

# Run a single spec in a visible browser
npx playwright test calendar-work-items --headed

# Filter by test title substring
npx playwright test -g "detail panel"

# Open the HTML report from the last run
npx playwright show-report
```

> **PowerShell quoting caveat:** wrap `-g` / `--grep` arguments in quotes. A leading `@` (as in `@smoke`) is safe inside single or double quotes, e.g. `npx playwright test --grep "@smoke"`. The `npm run test:e2e:smoke` and `test:e2e:a11y` scripts already handle this for you.

## Environments

The suite runs in two distinct modes. The **local full suite** (default) is
unchanged — it seeds/wipes `aipilot_e2e`, starts its own servers, and uses
`/auth/dev-login`. The **`deployed-smoke`** Playwright project instead runs a
small curated set of **read-only** journeys against an already-deployed site.

| Env | Auth | Scope | Data |
|-----|------|-------|------|
| **Local** | `/auth/dev-login` personas | full seed-driven Tier 0 suite (`chromium` project) | seeds/wipes `aipilot_e2e` |
| **Deployed Dev** | **programmatic Azure AD SSO** (`setup` project) | read-only `@deployed-smoke` vs deployed URL | no seeding — `/e2e/*` endpoints don't exist there |
| **Staging** | **programmatic Azure AD SSO** (`setup` project) | read-only `@deployed-smoke` | no seeding, no writes |
| **Prod** | **none — unauthenticated** | read-only `@prod-safe` boundary only | strictly read-only — no writes, no login, ever |

> **Programmatic SSO model (dev + staging).** Deployed dev (`app-scrum-dev`) and
> the staging slot run with `NODE_ENV=production`, and `/auth/dev-login` is gated
> to non-production only (`src/server/routes/auth.ts`). So dev-login is **not**
> available there. Instead, a dedicated Playwright `setup` project
> (`tests/e2e/support/auth.setup.ts`) performs a **fully-automated, programmatic
> Azure AD (Entra) SSO login each run** using a dedicated test account
> (`E2E_TEST_USER` / `E2E_TEST_PASSWORD`). It drives the real Microsoft login
> form and writes a **fresh, ephemeral** `storageState` to
> `tests/e2e/.auth/deployed.json` — there is **no** stored or manually-captured
> session blob. The `deployed-smoke` project then `dependencies: ['setup']` and
> reuses that session. `/auth/dev-login` remains the auth path for **local** runs
> (and any target where `NODE_ENV !== 'production'`).

> **Prod stays unauthenticated.** Production runs the `@prod-safe` subset with
> **no credentials and no `setup` project** — only the strictly read-only
> boundary. Authenticated navigation is covered on dev + staging, never against
> production.

> **Beta announcement modal is suppressed on deployed-smoke.** Deployed dev and
> staging can serve a blocking "Welcome to Apex Production" modal
> (`src/client/components/BetaAnnouncementModal.tsx`), gated by the
> `beta-to-prod-announcement` feature flag. For a non–super-admin it has no
> dismiss button and locks the page, which would block the authenticated SSO test
> account. The authenticated `@deployed-smoke` tests therefore call
> `suppressBetaAnnouncement(page)` (in `support/api-stubs.ts`) **before** login —
> it intercepts `GET /api/feature-flags/evaluate*`, keeps every real flag, and
> forces only `beta-to-prod-announcement` to `false`. It is a no-op locally (the
> flag is off there) and is **not** applied to the unauthenticated
> login-boundary test or the unauthenticated prod run, so the `@prod-safe` prod
> path is unaffected.

> **⚠️ MFA / conditional-access exemption is a prerequisite.** Programmatic login
> **cannot** clear an interactive MFA challenge or a conditional-access prompt.
> The dedicated E2E test account **must be exempted from MFA / conditional access**
> for the environments under test (e.g. a trusted-IP / named-location exclusion,
> or a security-group exclusion on the CA policy). Without this, the `setup`
> project hangs on the MFA screen and times out.

> **Entra selectors may need per-tenant tuning.** `auth.setup.ts` uses the
> well-known Entra element ids (`#i0116`, `#i0118`, `#idSIButton9`) with
> generic-type fallbacks (`input[type=email]`, `input[type=password]`,
> `input[type=submit]`). If Amergis's tenant customises the login page, update the
> locators in `auth.setup.ts` (and nowhere else).

### Env vars

| Var | Purpose |
|-----|---------|
| `E2E_BASE_URL` | Base URL of the deployed site. Setting it switches Playwright to *deployed-target* mode: no local `webServer`, no migrations/seeding, and the `deployed-smoke` project is enabled. Leave unset for the local full suite. |
| `E2E_TEST_USER` | UPN/email of the dedicated Azure AD E2E test account. **Primary** auth path for dev + staging: when set together with `E2E_TEST_PASSWORD`, the `setup` project runs programmatic SSO login and `loginAsPersona(...)` becomes a no-op. Never used for prod. |
| `E2E_TEST_PASSWORD` | Password for the dedicated E2E test account. Store as a secret; never commit it. |
| `E2E_STORAGE_STATE` | *(Optional local fallback.)* Path to a pre-captured SSO `storageState` JSON. Used **only** when no `E2E_TEST_USER`/`E2E_TEST_PASSWORD` are provided. When set, `loginAsPersona(...)` becomes a no-op and tests reuse the stored session. Never commit — `tests/e2e/.auth/` is gitignored. |

### Curated smoke set

`@deployed-smoke` (safe on any deployed env — read-only, never touches `/e2e/*`):

| Spec | Test | `@prod-safe`? | Auth |
|------|------|:---:|------|
| `auth-project-selection` | unauthenticated visit shows the login UI | ✅ | none |
| `auth-project-selection` | BA persona … sees the project selector | ✅ | required |
| `auth-project-selection` | app shell renders with sidebar and header | ✅ | required |
| `calendar-work-items` | navigating directly to /calendar works | — | required |
| `interview-dashboard` | dashboard loads with section buttons | — | required |

`@prod-safe` is the strict subset that never seeds, mutates, or calls `/e2e/*`.
On **dev + staging** it runs fully authenticated (via the programmatic SSO
`setup` session), exercising the read-only shell/project-selector renders. On
**production** the same subset runs **unauthenticated** (no `setup`, no
credentials): only the unauthenticated login-boundary check is expected to pass
there — the authenticated renders are covered on dev + staging. The prod job is
non-blocking, so this never gates a deploy or swap.

### Run deployed-smoke locally against any env

```powershell
# Dry-run the UNAUTHENTICATED prod-safe wiring against your LOCAL server
# (must already be running). No creds, no setup project:
$env:E2E_BASE_URL="http://127.0.0.1:3000"; npx playwright test --project=deployed-smoke --grep "@prod-safe"

# Against deployed dev / staging using programmatic SSO. Setting the test-account
# credentials enables the `setup` project, which logs in and produces a fresh
# ephemeral storageState the deployed-smoke project consumes:
$env:E2E_BASE_URL="https://app-scrum-dev.azurewebsites.net"
$env:E2E_TEST_USER="apex-e2e@amergis.com"
$env:E2E_TEST_PASSWORD="<the-account-password>"
npm run test:e2e:deployed

# Prod-safe subset (unauthenticated — do NOT pass credentials for prod):
$env:E2E_BASE_URL="https://app-apex-prd.azurewebsites.net"
npm run test:e2e:deployed:prod
```

### Optional local fallback: manual SSO storageState capture

The CI/deployed auth path is **credentials-based** (programmatic SSO via the
`setup` project). The one-time capture script remains available only as an
**optional local fallback** — e.g. when debugging against an env whose tenant
login page the automated selectors can't yet drive. It is not used by CI.

```powershell
$env:E2E_BASE_URL="https://app-scrum-dev.azurewebsites.net"
$env:E2E_STORAGE_STATE="tests/e2e/.auth/dev.storageState.json"   # optional; defaults to tests/e2e/.auth/storageState.json
npm run test:e2e:auth:capture
```

A headed browser opens; log in as the dedicated **E2E test account**, then press
ENTER in the terminal to save the `storageState`. Then run with that same
`E2E_STORAGE_STATE` set (and no `E2E_TEST_USER`/`E2E_TEST_PASSWORD`).

### Pipeline wiring & required GitHub config

Post-deploy smoke jobs run automatically (non-blocking — they never block a
deploy or swap):

| Workflow | Job | Target | Auth | Tag filter |
|----------|-----|--------|------|-----------|
| `pr-tests.yml` | `deployed-smoke-dev` | deployed dev | programmatic SSO (`setup`) | `@deployed-smoke` |
| `deploy.yml` | `deployed-smoke-staging` | staging slot | programmatic SSO (`setup`) | `@deployed-smoke` |
| `deploy.yml` | `deployed-smoke-prod` | production | **unauthenticated** | `@prod-safe` |

Required repo **variables** (`Settings → Secrets and variables → Actions → Variables`):

| Variable | Default if unset |
|----------|------------------|
| `E2E_DEV_BASE_URL` | `https://app-scrum-dev.azurewebsites.net` |
| `E2E_STAGING_BASE_URL` | `https://app-apex-prd-staging.azurewebsites.net` (the pre-swap staging slot) |
| `E2E_PROD_BASE_URL` | `https://app-apex-prd.azurewebsites.net` |

Required repo **secrets** — the dedicated Azure AD test-account credentials used
by the dev + staging programmatic-SSO `setup` project. **Prod uses no secrets**
(it runs unauthenticated). Without these, dev/staging fall back to only the
unauthenticated boundary passing.

| Secret | Used by |
|--------|---------|
| `E2E_TEST_USER` | `deployed-smoke-dev`, `deployed-smoke-staging` |
| `E2E_TEST_PASSWORD` | `deployed-smoke-dev`, `deployed-smoke-staging` |

> **The E2E test account must be MFA / conditional-access exempt** for dev +
> staging — programmatic login cannot clear an interactive MFA challenge. See the
> MFA prerequisite note in the [Environments](#environments) section.

> **Staging URL is not a fixed standalone environment.** Prod deploys via a
> `staging` deployment *slot* on `app-apex-prd` (→ `app-apex-prd-staging.azurewebsites.net`),
> which is swapped into production. That slot URL is the default staging target;
> override it with `E2E_STAGING_BASE_URL` if a dedicated staging environment
> exists. Never commit real secrets.

## Prerequisites

The E2E tests need two databases on the **same** local Postgres server:
1. Your application database — `DATABASE_URL` (normal development use).
2. A separate E2E test database — `TEST_DATABASE_URL` (so browser tests never touch real data).

Both live in the repo-root `.env` file. `TEST_DATABASE_URL` should point at an `aipilot_e2e` database on the same server as `DATABASE_URL`:

```
DATABASE_URL=postgresql://pgadmin:yourpassword@localhost:5432/aipilot
TEST_DATABASE_URL=postgresql://pgadmin:yourpassword@localhost:5432/aipilot_e2e
```

If `TEST_DATABASE_URL` is left unset, both the Playwright config and the create-db script derive it by appending `_e2e` to the `DATABASE_URL` database name.

### Setting up the test database

Create the E2E database once. This uses the bundled `pg` module and connects to the server's `postgres` maintenance DB — **no `psql` or `createdb` on your PATH required** (important on Windows):

```powershell
npm run test:e2e:create-db
```

The `global-setup.ts` then runs `npm run migrate:up` against `TEST_DATABASE_URL` automatically before the suite starts, so you don't migrate the test DB by hand.

### Stop the dev server first

Playwright launches its own Express (3001) and Vite (3000) servers with `E2E_MODE=true`. Stop any running `npm run dev` before starting a run so it doesn't hold ports 3000/3001. (Playwright will reuse an existing server locally if one is already listening, which can mask config differences — a clean shutdown avoids surprises.)

### Resetting after a crashed run

If tests were interrupted (Ctrl-C), orphaned `[E2E]`-prefixed records may remain in the test DB. Clean them up with:

```powershell
npm run test:e2e:reset-db
```

## Architecture

```
tests/e2e/
├── specs/              # Spec files (one per domain)
├── pages/              # Page objects (one per screen/component)
├── support/
│   ├── fixtures.ts     # Custom test fixtures (loginAsPersona, e2eApi)
│   ├── auth.ts         # Dev-login helpers
│   ├── api-stubs.ts    # Route interceptors for ADO, AI, SSE
│   ├── global-setup.ts # Runs migrations before the suite
│   └── global-teardown.ts
└── data/
    ├── seed.ts         # Seed helpers via /e2e/* endpoints
    └── reset.ts        # Standalone cleanup script
```

## Test personas

All tests use the dev mock personas defined in `src/shared/constants/devMockUsers.ts`.
These are seeded by the `20260623150000_seed-dev-mock-users.sql` migration.

| Persona | Role | Groups | Key test use |
|---------|------|--------|--------------|
| `ba` | member | BA | Start interviews, PRD review |
| `developer` | member | Developer | Calendar, my-work |
| `manager` | member | Manager | Standup manage, interview start |
| `product-owner` | member | Product-Owner | Interview start, PRD owner |
| `qa` | member | QA | PRD review, test cases |
| `ui-ux` | member | UI/UX | UI Lab |

Super-admin browser coverage is deferred to Tier 1.

## Stubbing strategy

External systems are **never** called from E2E tests:

| System | Stub mechanism |
|--------|---------------|
| Azure DevOps (work items) | `page.route('**/api/workitems*', ...)` |
| ADO (projects list) | `page.route('**/api/projects', ...)` |
| ADO export | `page.route('**/api/workitems/from-prd', ...)` |
| SSE notification stream | `page.route('**/api/notifications/stream', ...)` |
| AI / Bedrock / Cursor SDK | Not invoked in E2E mode (E2E_MODE=true suppresses AI routes) |

## Adding a new spec

1. Create `tests/e2e/specs/<domain>.spec.ts`.
2. Import from `../support/fixtures` (not directly from `@playwright/test`).
3. Tag tests with `@smoke` for Tier 0 or `@regression` for Tier 1.
4. Add a page object in `tests/e2e/pages/` if the test drives a new screen.
5. Seed state via `SeedApi` methods; clean up in `afterEach` with `SeedApi.reset(e2eApi)`.
6. Stub any external API calls via `tests/e2e/support/api-stubs.ts`.
7. Link the scenario to its acceptance criterion in a comment at the top.

## Selector guidelines

Prefer in order:
1. `getByTestId(...)` when a `data-testid` exists (e.g. `nav-item-*` on the sidebar).
2. `getByRole(...)` for interactive elements (buttons, links, checkboxes).
3. `getByText(...)` for unique content labels.
4. Avoid CSS selectors or class-based locators — they break on style refactors.

When a component lacks a suitable selector, add `data-testid` to the component and document it here.

## CI

| Gate | Trigger | Suite |
|------|---------|-------|
| PR smoke | Every PR to main | `@smoke` tests only |
| Nightly full regression | 02:00 UTC daily | All specs + `@a11y` |
| Nightly integration | 02:00 UTC daily | `tests/integration/**` |
