# Apex codemap
Updated 2026-09-29. Read before searching. Product overview: `context.md`. Feature → file map: `AGENTS.md`.

## Stack
React + Vite client, Express + TypeScript server, PostgreSQL via Drizzle, SQL migrations via node-pg-migrate,
Jest + Testing Library, Playwright E2E, Terraform on Azure.

## Top level
- `src/`: the app (~1,770 files), see below.
- `migrations/`: node-pg-migrate SQL, `YYYYMMDDHHMMSS_<slug>.sql`.
- `tests/e2e/`: Playwright. `specs/`, `pages/` (page objects), `support/` (auth capture), `data/` (seed/reset, hand-written).
- `tests/integration/`: `*.integration.test.ts`, run with `jest.config.integration.js`.
- `foundation-skills/`: packaged skills library (`catalog.json`, `foundation/`, `adapters/`, `bin/`, `test/`); published by `.github/workflows/publish-apex-skills.yml`.
- `runners/`: container workers, one Dockerfile each: `ai-runs`, `ai-runs-interactive`, `load-test-k6`, `repo-read-service`.
- `infra/`: Terraform, one `.tf` per capability (`main`, `shared-async`, `ai-runs-worker`, `load-test`, `pdf-processing`, `repo-read-service`). Standards: `.cursor/skills/terraform-infra/SKILL.md`.
- `scripts/`: CI (`ci/`), E2E helpers (`e2e/`), changelog, dev→prod migration.
- `design-docs/`: feature design docs. `docs/`: setup and ops (auth, Azure cost, release, security).
- `public/`: static assets; `CHANGELOG.json` is the release record.
- `teams-app/`: Teams manifests (`dev/`, `prod/`). `.ai-pilot/`: kickoff transcripts and generated PRD output.
- `.github/workflows/`: `pr-tests.yml`, `deploy.yml`, `deploy-dev-quick.yml`, `e2e-nightly.yml`, `e2e-triage.yml`, publish jobs.
- Config: `vite.config.ts`, `server.js`, `tsconfig.{client,server,e2e,node,jest.client,jest.server}.json`, `jest.config.js`,
  `jest.config.integration.js`, `playwright.config.ts`. Ask before editing (scope-discipline rule).

## src/server (Express)
- `index.ts`: entry point, mounts routes. Ask before editing.
- `routes/`: one router per area (44), e.g. `featureRequests.ts`, `interviews.ts`, `notifications.ts`, `platformAdmin.ts`,
  `walkthroughs.ts`. `auth.ts` needs permission to edit.
- `services/`: business logic (~270), `<area>Service.ts`.
- `db/drizzle.ts`, `db/schema.ts` (2,700 lines; search it, don't read it whole).
- `middleware/`: `auth.ts`, `rbac.ts`, `publicApiKeyAuth.ts`, `aiRunnerAuth.ts`, `loadTestRunnerAuth.ts`, observability capture.
- `mcp/`: MCP servers Apex exposes: `ado/`, `github/`, `maxview/`, `calendarAssistant/`, `board/`.
- `utils/` (`dataDir.ts` = persistent data root), `skills/`, `assets/`, `types/`.
- `__tests__/`: all server unit tests (~365), one flat folder.

## src/client (React)
- `App.tsx` (1,500 lines): routes and views. Search for the route; don't read it whole.
- `components/`: flat, `Foo.tsx` + `Foo.module.css`; tests in `components/__tests__/`. Subfolders: `agentChat/`, `icons/`.
- `hooks/`: TanStack Query hooks `useXxx.ts`; tests in `hooks/__tests__/`.
- `utils/`, `contexts/` (NotificationContext), `config/` (env, models, release), `observability/`, `services/`.

## src/shared
- `types/`: types shared by client and server (`menuSettings.ts` = nav items and visibility).
- `walkthroughRoutes.ts`, `walkthroughAnchors.ts`, `skillPaths.ts`, `utils/`, `constants/`, `config/`.

## Examples to copy
Feature Requests is a complete slice through every layer:
- Route: `src/server/routes/featureRequests.ts`
- Service: `src/server/services/featureRequestService.ts`
- Server tests: `src/server/__tests__/featureRequestService.test.ts`, `featureRequestRoutes.test.ts`
- Hook: `src/client/hooks/useFeatureRequests.ts` + `hooks/__tests__/useFeatureRequests.test.ts`
- Component: `src/client/components/FeatureRequestModal.tsx` + `.module.css` + `components/__tests__/FeatureRequestModal.test.tsx`
- Pure util: `src/client/utils/featureRequestRank.ts` + `utils/__tests__/featureRequestRank.test.ts`
- Migration: newest file in `migrations/`; create with `npm run migrate:create -- <slug>`
- Integration test: `tests/integration/notifications.integration.test.ts`
- E2E: `tests/e2e/specs/access-control.spec.ts` + a page object in `tests/e2e/pages/`
- Rules: `.cursor/rules/react-coding-standards.mdc`, `ui-design-standards.mdc`, `postgresql-db.mdc`, `rbac-governance.mdc`,
  `feature-flags.mdc`, `agent-chat-surfaces.mdc`

## Commands (quietest form)
- One unit test: `npx jest src/server/__tests__/featureRequestService.test.ts --silent`
- One folder: `npx jest src/client/hooks --silent`
- One integration test (needs a database): `npx jest --config jest.config.integration.js tests/integration/<file> --silent`
- Typecheck: `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.client.json --noEmit`
- Lint changed files: `ESLINT_USE_FLAT_CONFIG=false npx eslint <files> --ext .ts,.tsx`
- Format check: `npx prettier --check <files>`
- One E2E spec: `npx playwright test tests/e2e/specs/<file> --reporter=line`
- Local migrations: `npm run migrate:local:up`

## Cross-repo touchpoints
- MaxView: `src/server/mcp/maxview/`, `src/server/services/maxviewAuthService.ts`
- Azure DevOps: `src/server/services/azureDevOps.ts`, `src/server/mcp/ado/`
- GitHub: `src/server/mcp/github/`
- Which repo's skills a project uses: `src/server/services/projectSettingsService.ts`
- Runner ↔ server contracts: `src/server/routes/aiRunsInternal.ts`, `loadTestRunsInternal.ts`, `middleware/aiRunnerAuth.ts`

## Don't read
`node_modules/`, `dist/`, root `data/`, `package-lock.json`, `playwright-report/`, `test-results/`, `teams-app*.zip`.
