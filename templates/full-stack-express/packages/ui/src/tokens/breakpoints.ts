/**
 * Breakpoints in px. Phone is below `sm`, tablet is `sm` to below `md`, and
 * desktop is `md` and up.
 */
export const breakpoints = {
  xs: 0,
  sm: 600,
  md: 900,
  lg: 1200,
  xl: 1536,
} as const;

export type BreakpointTokens = typeof breakpoints;
