export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as EffortLevel);
}
