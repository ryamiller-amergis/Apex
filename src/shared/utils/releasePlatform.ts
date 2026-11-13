/**
 * Derive a normalized platform label from an Azure DevOps Area Path.
 * Inspects only the leaf segment (after the last backslash or forward slash).
 */
export function deriveReleasePlatform(areaPath?: string | null, fallbackProject?: string | null): string {
  const trimmed = (areaPath ?? '').trim();
  if (!trimmed) {
    const fallback = (fallbackProject ?? '').trim();
    return fallback || 'General';
  }

  const segments = trimmed.split(/[\\/]/).filter(Boolean);
  const leaf = segments.length > 0 ? segments[segments.length - 1].trim() : trimmed;
  if (!leaf) {
    const fallback = (fallbackProject ?? '').trim();
    return fallback || 'General';
  }

  const lower = leaf.toLowerCase();
  if (lower.includes('mobile')) return 'Mobile';
  if (lower.includes('desktop')) return 'Desktop';
  return leaf;
}

/**
 * Validate that a candidate Area Path belongs to the given ADO project.
 */
export function isAreaPathInProject(areaPath: string, project: string): boolean {
  const normalizedArea = areaPath.trim().replace(/\//g, '\\').toLowerCase();
  const normalizedProject = project.trim().toLowerCase();
  if (!normalizedArea || !normalizedProject) return false;
  return normalizedArea === normalizedProject || normalizedArea.startsWith(`${normalizedProject}\\`);
}
