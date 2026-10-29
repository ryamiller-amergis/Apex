import type { TokenOverrides } from '@project-scope/ui';

/**
 * Brand token overrides for this app, empty by default. Each colour scheme
 * merges on its own. Check the result with
 * `pnpm --filter @project-scope/ui check:contrast --overrides ../../apps/web/src/theme/overrides.ts`.
 * See packages/ui/README.md, "Override tokens".
 */
const overrides: TokenOverrides = {};

export default overrides;
