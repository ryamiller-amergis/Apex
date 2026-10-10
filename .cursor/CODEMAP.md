# Apex codemap

Read before searching. Product overview: `context.md`. Feature → file map: `AGENTS.md`.
Kept in sync by `.cursor/rules/codemap-sync.mdc`; `npm run lint:codemap` checks that every listed path exists.

## Stack

React + Vite client, Express + TypeScript server, PostgreSQL via Drizzle, SQL migrations via node-pg-migrate,
Jest + Testing Library, Playwright E2E, Terraform on Azure.

## Top level

- `src/`: the app, see below.
- `migrations/`: node-pg-migrate SQL, `YYYYMMDDHHMMSS_<slug>.sql`.
- `tests/e2e/`: Playwright. `tests/e2e/specs/`, `tests/e2e/pages/` (page objects), `tests/e2e/support/` (auth capture), `tests/e2e/data/` (seed/reset, hand-written).
- `tests/integration/`: `*.integration.test.ts`, run with `jest.config.integration.js`.
- `foundation-skills/`: packaged skills library (`foundation-skills/catalog.json`, `foundation-skills/foundation/`, `foundation-skills/adapters/`); published by `.github/workflows/publish-apex-skills.yml`.
- `runners/`: container workers, one Dockerfile each: `runners/ai-runs/`, `runners/ai-runs-interactive/`, `runners/load-test-k6/`, `runners/repo-read-service/`.
- `infra/`: Terraform, one `.tf` per capability (`infra/main.tf`, `infra/shared-async.tf`, `infra/ai-runs-worker.tf`, `infra/load-test.tf`, `infra/pdf-processing.tf`, `infra/repo-read-service.tf`). Standards: `.cursor/skills/terraform-infra/SKILL.md`.
- `scripts/`: CI checks (`scripts/ci/`), E2E helpers (`scripts/e2e/`), changelog, dev→prod migration.
- `design-docs/`: feature design docs. `docs/`: setup and ops (auth, Azure cost, release, security).
- `public/`: static assets; `public/CHANGELOG.json` is the release record.
- `teams-app/`: Teams manifests (`teams-app/dev/`, `teams-app/prod/`). `.ai-pilot/`: kickoff transcripts and generated PRD output.
- `.github/workflows/`: `.github/workflows/pr-tests.yml`, `.github/workflows/deploy.yml`, `.github/workflows/deploy-dev-quick.yml`, `.github/workflows/e2e-nightly.yml`, `.github/workflows/e2e-triage.yml`.
- Config: `vite.config.ts`, `server.js`, `tsconfig.{client,server,e2e,node,jest.client,jest.server}.json`, `jest.config.js`,
  `jest.config.integration.js`, `playwright.config.ts`. Ask before editing (scope-discipline rule).

## src/server (Express)

- `src/server/index.ts`: entry point, mounts routes. Ask before editing.
- `src/server/routes/`: one router per area, e.g. `src/server/routes/featureRequests.ts`, `src/server/routes/interviews.ts`,
  `src/server/routes/notifications.ts`, `src/server/routes/platformAdmin.ts`, `src/server/routes/walkthroughs.ts`.
  `src/server/routes/auth.ts` needs permission to edit.
- `src/server/services/`: business logic, `<area>Service.ts`.
- `src/server/db/drizzle.ts`, `src/server/db/schema.ts` (large; search it, don't read it whole).
- `src/server/middleware/`: `src/server/middleware/auth.ts`, `src/server/middleware/rbac.ts`, `src/server/middleware/publicApiKeyAuth.ts`,
  `src/server/middleware/aiRunnerAuth.ts`, `src/server/middleware/loadTestRunnerAuth.ts`, observability capture.
- `src/server/mcp/`: MCP servers Apex exposes: `src/server/mcp/ado/`, `src/server/mcp/github/`, `src/server/mcp/maxview/`,
  `src/server/mcp/calendarAssistant/`, `src/server/mcp/board/`.
- `src/server/utils/` (`src/server/utils/dataDir.ts` = persistent data root), `src/server/skills/`, `src/server/assets/`, `src/server/types/`.
- `src/server/__tests__/`: all server unit tests, one flat folder.

## src/client (React)

- `src/client/App.tsx`: routes and views. Large; search for the route instead of reading it whole.
- `src/client/components/`: flat, `Foo.tsx` + `Foo.module.css`; tests in `src/client/components/__tests__/`.
  Subfolders: `src/client/components/agentChat/`, `src/client/components/icons/`.
- `src/client/hooks/`: TanStack Query hooks `useXxx.ts`; tests in `src/client/hooks/__tests__/`.
- `src/client/utils/`, `src/client/contexts/` (NotificationContext), `src/client/config/` (env, models, release),
  `src/client/observability/`, `src/client/services/`.

## src/shared

- `src/shared/types/`: types shared by client and server (`src/shared/types/menuSettings.ts` = nav items and visibility).
- `src/shared/walkthroughRoutes.ts`, `src/shared/walkthroughAnchors.ts`, `src/shared/skillPaths.ts`, `src/shared/utils/`,
  `src/shared/constants/`, `src/shared/config/`.

## Examples to copy

Feature Requests is a complete slice through every layer:

- Route: `src/server/routes/featureRequests.ts`
- Service: `src/server/services/featureRequestService.ts`
- Server tests: `src/server/__tests__/featureRequestService.test.ts`, `src/server/__tests__/featureRequestRoutes.test.ts`
- Hook: `src/client/hooks/useFeatureRequests.ts` + `src/client/hooks/__tests__/useFeatureRequests.test.ts`
- Component: `src/client/components/FeatureRequestModal.tsx` + `src/client/components/FeatureRequestModal.module.css`
  - `src/client/components/__tests__/FeatureRequestModal.test.tsx`
- Pure util: `src/client/utils/featureRequestRank.ts` + `src/client/utils/__tests__/featureRequestRank.test.ts`
- Migration: newest file in `migrations/`; create with `npm run migrate:create -- <slug>`
- Integration test: `tests/integration/notifications.integration.test.ts`
- E2E: `tests/e2e/specs/access-control.spec.ts` + a page object in `tests/e2e/pages/`
- Rules: `.cursor/rules/react-coding-standards.mdc`, `.cursor/rules/ui-design-standards.mdc`, `.cursor/rules/postgresql-db.mdc`,
  `.cursor/rules/rbac-governance.mdc`, `.cursor/rules/feature-flags.mdc`, `.cursor/rules/agent-chat-surfaces.mdc`

## Commands (quietest form)

- One unit test: `npx jest src/server/__tests__/featureRequestService.test.ts --silent`
- One folder: `npx jest src/client/hooks --silent`
- One integration test (needs a database): `npx jest --config jest.config.integration.js tests/integration/<file> --silent`
- Typecheck: `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`
- Lint changed files: `ESLINT_USE_FLAT_CONFIG=false npx eslint <files> --ext .ts,.tsx`
- Format check: `npx prettier --check <files>`
- Codemap paths: `npm run lint:codemap`
- One E2E spec: `npx playwright test tests/e2e/specs/<file> --reporter=line`
- Local migrations: `npm run migrate:local:up`

## Cross-repo touchpoints

- MaxView: `src/server/mcp/maxview/`, `src/server/services/maxviewAuthService.ts`
- Azure DevOps: `src/server/services/azureDevOps.ts`, `src/server/mcp/ado/`
- GitHub: `src/server/mcp/github/`
- Which repo's skills a project uses: `src/server/services/projectSettingsService.ts`
- Runner ↔ server contracts: `src/server/routes/aiRunsInternal.ts`, `src/server/routes/loadTestRunsInternal.ts`,
  `src/server/middleware/aiRunnerAuth.ts`

## Don't read

`node_modules/`, `dist/`, root `data/`, `package-lock.json`, `playwright-report/`, `test-results/`, `teams-app*.zip`.
