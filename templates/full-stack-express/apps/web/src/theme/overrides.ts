import type { TokenOverrides } from '@project-scope/ui';

export interface BrandConfig {
  appName: string;
  tagline: string;
  logoSvg: string;
  overrides: TokenOverrides;
}

/**
 * Typed brand configuration and WCAG AA-compliant token overrides.
 * Check contrast with:
 * `pnpm --filter @project-scope/ui check:contrast --overrides ../../apps/web/src/theme/overrides.ts`
 */
export const brandConfig: BrandConfig = {
  appName: 'Northstar Ops',
  tagline: 'Fulfillment & Intelligent Workflow Hub',
  logoSvg:
    '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="8" fill="#1D4ED8"/><path d="M16 6L20 14L28 16L20 18L16 26L12 18L4 16L12 14L16 6Z" fill="#FFFFFF"/></svg>',
  overrides: {
    colors: {
      light: {
        primary: { main: '#1D4ED8', contrastText: '#FFFFFF' },
        secondary: { main: '#334155', contrastText: '#FFFFFF' },
      },
      dark: {
        primary: { main: '#8AB4F8', contrastText: '#0B1220' },
        secondary: { main: '#B0B6BE', contrastText: '#101418' },
      },
    },
  },
};

const overrides: TokenOverrides = brandConfig.overrides;

export default overrides;
