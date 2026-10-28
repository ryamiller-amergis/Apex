# Module map

One entry per workspace member listed in `pnpm-workspace.yaml`. Each entry names what the member is responsible for and what other members may import from it. `pnpm docs:check` reports a member with no entry, or an entry with an empty responsibility or public interface.

When you add a member, add a `###` heading whose text is the member's path, then fill in every field.

### `apps/api`

**Responsibility:** The Express HTTP API. Authenticates callers, validates requests against the contracts, runs services, reads and writes PostgreSQL, serves the built web client in production, and provides the `migrate` and `seed` commands.

**Public interface:** HTTP only. The routes defined in `packages/contracts/src/routes/` (`GET /health/live`, `GET /health/ready`, `GET /api/v1/me`, `PUT /api/v1/me`). Command-line entries `apps/api/src/cli/migrate.ts` and `apps/api/src/cli/seed.ts`. No other member imports this package.

**Depends on:** `@project-scope/contracts`, `@project-scope/config`.

**Key files:** `apps/api/src/index.ts` (composition root), `apps/api/src/app.ts` (middleware and routes), `apps/api/src/config/env.ts` (environment), `apps/api/src/identity/registry.ts` (identity adapters), `apps/api/src/persistence/schema.ts` (database schema), `apps/api/README.md` (routes, errors, probes).

### `apps/web`

**Responsibility:** The React single-page client. Renders the profile screens inside the shared application shell, keeps server state in TanStack Query, and parses every response with the contract schemas.

**Public interface:** The built static files in `apps/web/dist`, which the API serves from `CLIENT_DIST_DIR`. The routes `/profile` and `/profile/details/edit`. No other member imports this package.

**Depends on:** `@project-scope/contracts`, `@project-scope/ui`, `@project-scope/config`.

**Key files:** `apps/web/src/main.tsx` (entry), `apps/web/src/app/routes.tsx` (routes), `apps/web/src/api/apiClient.ts` (HTTP client), `apps/web/src/theme/overrides.ts` (brand tokens), `apps/web/src/features/profile/` (reference feature).

### `packages/config`

**Responsibility:** Shared tool settings: TypeScript base configs, the ESLint flat config and its custom rules, Prettier, Vitest project defaults, the coverage floors, and the environment-error formatter.

**Public interface:** The `exports` in `packages/config/package.json`. The TypeScript configs are `packages/config/tsconfig.base.json`, `packages/config/tsconfig.node.json`, and `packages/config/tsconfig.react.json`. The other export names are `./eslint`, `./prettier`, `./vitest`, `./testing` (`coverageFloors`, `coverageScope`, `defineTestProject`), and `./format-env-issues`.

**Depends on:** Tool packages only. No workspace member.

**Key files:** `packages/config/eslint.mjs`, `packages/config/testing.mjs`, `packages/config/tsconfig.base.json`.

### `packages/contracts`

**Responsibility:** The single definition of every API route in Zod: paths, auth rule, request and response schemas, and Problem Details errors. Generates and checks the committed OpenAPI 3.1 document.

**Public interface:** `@project-scope/contracts` (`defineRoute`, `routes`, `routeList`, `compareRouteInventory`, `problemDetailsSchema`, `problemTypes`, `zodIssuesToProblemErrors`, pagination and request-ID helpers, and the `Infer*` types), `@project-scope/contracts/openapi` (`buildOpenApiDocument`), and `@project-scope/contracts/openapi.json`. The entry file is `packages/contracts/src/index.ts`.

**Depends on:** `zod` only, at runtime.

**Key files:** `packages/contracts/src/define-route.ts`, `packages/contracts/src/registry.ts`, `packages/contracts/openapi/openapi.json`, `packages/contracts/README.md` (conventions for a new endpoint).

### `packages/ui`

**Responsibility:** The neutral MUI design system: semantic tokens, light and dark themes, component defaults, the contrast check, the application shell, the error boundary, and the loading, empty, and error states.

**Public interface:** `@project-scope/ui`, from the entry file `packages/ui/src/index.ts`. Every export is listed in the [component catalog](component-catalog.md). Import from the package name only, never from `src/` or `dist/` paths.

**Depends on:** `react-error-boundary`. Peers: `react`, `react-dom`, `@mui/material`, `@emotion/react`, `@emotion/styled`, `react-router`.

**Key files:** `packages/ui/src/tokens/index.ts`, `packages/ui/src/theme/createAppTheme.ts`, `packages/ui/src/shell/AppShell.tsx`, `packages/ui/README.md`.
