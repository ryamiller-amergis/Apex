# Code map

Keep each entry to one line with the full repo-relative path. Update it in the same change when a listed path moves.

## Top level

- `apps/api/`: Express HTTP API, Drizzle PostgreSQL persistence, identity adapters, and route handlers
- `apps/web/`: React + MUI single-page client with TanStack Query and React Hook Form
- `packages/contracts/`: Zod route definitions (`defineRoute`), Problem Details schemas, and generated OpenAPI 3.1 document
- `packages/ui/`: shared MUI design system (`AppShell`, `LoadingState`, `EmptyState`, `ErrorState`, tokens, theme, `testId`)
- `packages/config/`: shared TypeScript, ESLint (`design-tokens/no-hardcoded-color`), Prettier, and Vitest configurations
- `docs/`: architecture, module map, feature-slice guide, API docs, design system, component catalog, and ADRs
- `quality/`: quality gate manifest (`quality/quality-manifest.json`) and NFR manifest (`quality/nfr-manifest.json`)
- `.cursor/skills/`: role skills (`build-*`) and domain skills (`api-contract`, `ui-standards`, `design-system`)
- `.cursor/rules/`: workspace coding rules (`.cursor/rules/react-mui-express.mdc`)

## Contracts (`packages/contracts`)

- `packages/contracts/src/index.ts`: public barrel exporting `defineRoute`, `routes`, `routeList`, `problemDetailsSchema`, and `Infer*` types
- `packages/contracts/src/define-route.ts`: Zod route contract builder
- `packages/contracts/src/registry.ts`: central route registry (`routes` and `routeList`)
- `packages/contracts/src/routes/health.ts`: health probe route definitions (`GET /health/live`, `GET /health/ready`)
- `packages/contracts/src/routes/me.ts`: reference principal-scoped route definitions (`GET /api/v1/me`, `PUT /api/v1/me`)
- `packages/contracts/src/conventions/problem-details.ts`: RFC 9457 Problem Details schema and `zodIssuesToProblemErrors`
- `packages/contracts/src/conventions/pagination.ts`: `paginationQuerySchema` (default 20, max 100) and `paginated(item)`
- `packages/contracts/src/conventions/request-id.ts`: `X-Request-Id` header convention
- `packages/contracts/openapi/openapi.json`: generated OpenAPI 3.1 document (`corepack pnpm openapi:generate`)

## Server (`apps/api`)

- `apps/api/src/index.ts`: composition root and server entrypoint
- `apps/api/src/app.ts`: Express middleware pipeline and contract route handler registration
- `apps/api/src/identity/authMiddleware.ts`: `createAuthMiddleware` and `getPrincipal`
- `apps/api/src/persistence/schema.ts`: Drizzle PostgreSQL schema
- `apps/api/src/features/profile/`: reference backend feature slice (routes, service, store)
- `apps/api/test/api/`: API integration tests
- `apps/api/test/contract/`: OpenAPI contract verification tests

## Client (`apps/web` and `packages/ui`)

- `apps/web/src/main.tsx`: client entrypoint mounting `AppThemeProvider` and `QueryClientProvider`
- `apps/web/src/app/App.tsx`: `AppShell` layout and primary `navItems` registration
- `apps/web/src/app/routes.tsx`: lazy route registration
- `apps/web/src/app/queryClient.ts`: `createAppQueryClient`
- `apps/web/src/api/apiClient.ts`: typed HTTP client and `ApiError` Problem Details handling
- `apps/web/src/theme/overrides.ts`: brand token overrides (`TokenOverrides`)
- `apps/web/src/features/profile/ProfileForm.tsx`: reference form using `react-hook-form`, `zodResolver`, `LoadingState`, `EmptyState`, `ErrorState`
- `apps/web/src/features/profile/useProfileQuery.ts`: reference `useQuery` hook
- `apps/web/src/features/profile/useUpdateProfileMutation.ts`: reference `useMutation` hook with query invalidation
- `apps/web/src/features/profile/profileKeys.ts`: reference query key factory
- `apps/web/src/features/profile/profileTestIds.ts`: reference `testId('profile', ...)` selectors
- `packages/ui/src/index.ts`: public exports (`AppShell`, `LoadingState`, `EmptyState`, `ErrorState`, `AppErrorBoundary`, `testId`, `tokens`)

## Commands

- Type-check: `corepack pnpm typecheck`
- Lint: `corepack pnpm lint`
- Related tests: `corepack pnpm vitest related --run {files}`
- Unit suite: `corepack pnpm test:unit`
- Component tests: `corepack pnpm test:component`
- API tests: `corepack pnpm test:api`
- Contract tests: `corepack pnpm test:contract`
- Regenerate OpenAPI: `corepack pnpm openapi:generate`
- Check route contracts: `corepack pnpm routes:check`
