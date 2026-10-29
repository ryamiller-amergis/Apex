/**
 * Spacing in px. `base` is the MUI unit, so `theme.spacing(n)` is
 * `n * base`. The named steps are `theme.spacing(0.5)` to `theme.spacing(4)`.
 */
export const spacing = {
  base: 8,
  steps: {
    xxs: 4,
    xs: 8,
    sm: 12,
    md: 16,
    lg: 24,
    xl: 32,
  },
} as const;

export type SpacingTokens = typeof spacing;
