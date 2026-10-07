export interface ModelOption {
  id: string;
}

const GENERIC_FALLBACK_MODEL_ID = 'default';

function modelFamily(id: string): string {
  const versionStart = /-\d/.exec(id);
  return (versionStart ? id.slice(0, versionStart.index) : id).toLowerCase();
}

/**
 * Resolve a requested model ID against the models the Cursor SDK currently
 * offers. A retired ID (for example a saved `claude-opus-4-6` default) maps to
 * the first listed model in the same family, then to `default`. An empty list
 * means the catalog could not be read, so the requested ID is kept.
 */
export function resolveAvailableModelId(
  requested: string,
  available: ReadonlyArray<ModelOption>,
): string {
  if (available.length === 0) return requested;
  if (available.some((model) => model.id === requested)) return requested;
  const family = modelFamily(requested);
  const sameFamily = available.find((model) => modelFamily(model.id) === family);
  if (sameFamily) return sameFamily.id;
  return (
    available.find((model) => model.id === GENERIC_FALLBACK_MODEL_ID)?.id ??
    available[0].id
  );
}
