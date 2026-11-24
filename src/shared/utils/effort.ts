import type { EffortLevel } from '../types/effort';

const EFFORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

/**
 * Returns the effort levels the Cursor SDK catalog declares for `modelId`,
 * or `null` when the model is unset or its catalog metadata is not yet loaded.
 * An empty array means the model explicitly accepts no effort parameter.
 */
export function effortLevelsForModel(
  modelId: string | null | undefined,
  availableModels: ReadonlyArray<{
    id: string;
    supportedEffortLevels?: ReadonlyArray<EffortLevel>;
  }>,
): ReadonlyArray<EffortLevel> | null {
  const trimmed = modelId?.trim();
  if (!trimmed) return null;
  const matched = availableModels.find((m) => m.id === trimmed);
  if (!matched || matched.supportedEffortLevels === undefined) return null;
  return matched.supportedEffortLevels;
}
