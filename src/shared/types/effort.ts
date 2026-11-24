export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.includes(value as EffortLevel);
}

/** Resolved Cursor SDK model parameter pair (e.g. `{ id: 'reasoning_effort', value: 'medium' }`). */
export type CursorModelParam = Readonly<{
  id: string;
  value: string;
}>;

/** Live parameter definition returned by `Cursor.models.list()`. */
export interface CursorModelParameterDefinition {
  id: string;
  displayName?: string;
  values: ReadonlyArray<{ value: string; displayName?: string }>;
}

export function isCursorModelParamList(
  value: unknown,
): value is ReadonlyArray<CursorModelParam> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        typeof (entry as Record<string, unknown>).id === 'string' &&
        (entry as Record<string, unknown>).id !== '' &&
        typeof (entry as Record<string, unknown>).value === 'string' &&
        (entry as Record<string, unknown>).value !== '',
    )
  );
}
