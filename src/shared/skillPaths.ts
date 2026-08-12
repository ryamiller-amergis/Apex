export const AGENT_SKILL_ROOT = '.agents/skills' as const;
export const LEGACY_CURSOR_SKILL_ROOT = '.cursor/skills' as const;
export const LEGACY_GENERIC_SKILL_ROOT = 'skills' as const;

/** Discovery precedence when a repository has no apex-skills lockfile. */
export const SKILL_DISCOVERY_ROOTS = [
  AGENT_SKILL_ROOT,
  LEGACY_CURSOR_SKILL_ROOT,
  LEGACY_GENERIC_SKILL_ROOT,
] as const;

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeRepoRelativePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/');
  return normalized
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

export function isSafeRepoRelativeRoot(value: string): boolean {
  const raw = value.trim().replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) return false;
  const normalized = normalizeRepoRelativePath(raw).replace(/\/+$/, '');
  return (
    normalized.length > 0 &&
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith('../') &&
    !normalized.includes('/../')
  );
}

export function normalizeSkillRoot(
  value: string | null | undefined,
  fallback = LEGACY_CURSOR_SKILL_ROOT
): string {
  const raw = value ?? fallback;
  if (!isSafeRepoRelativeRoot(raw)) {
    throw new Error(`Invalid repository-relative skill root: ${value}`);
  }
  const normalized = normalizeRepoRelativePath(raw).replace(/\/+$/, '');
  return normalized;
}

export function skillPathFor(root: string, skillName: string): string {
  if (!SKILL_NAME_RE.test(skillName)) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
  return `${normalizeSkillRoot(root)}/${skillName}/SKILL.md`;
}

export function isSupportedAgentSkillPath(value: string): boolean {
  const normalized = normalizeRepoRelativePath(value);
  return SKILL_DISCOVERY_ROOTS.some((root) => {
    if (!normalized.startsWith(`${root}/`)) return false;
    const suffix = normalized.slice(root.length + 1);
    const parts = suffix.split('/');
    return (
      parts.length === 2 &&
      SKILL_NAME_RE.test(parts[0]) &&
      parts[1] === 'SKILL.md'
    );
  });
}

export function skillRootFromLock(
  lock: { skillRoot?: unknown } | null | undefined
): string {
  return typeof lock?.skillRoot === 'string'
    ? normalizeSkillRoot(lock.skillRoot)
    : LEGACY_CURSOR_SKILL_ROOT;
}

export function skillRootPriority(skillPath: string): number {
  const normalized = normalizeRepoRelativePath(skillPath);
  const index = SKILL_DISCOVERY_ROOTS.findIndex(
    (root) => normalized === root || normalized.startsWith(`${root}/`)
  );
  return index === -1 ? SKILL_DISCOVERY_ROOTS.length : index;
}

export function selectSkillsByRootPrecedence<
  T extends { name: string; path: string },
>(
  skills: T[]
): { skills: T[]; collisions: Array<{ name: string; paths: string[] }> } {
  const byName = new Map<string, T[]>();
  for (const skill of skills) {
    const key = skill.name.toLowerCase();
    const entries = byName.get(key) ?? [];
    entries.push(skill);
    byName.set(key, entries);
  }

  const selected: T[] = [];
  const collisions: Array<{ name: string; paths: string[] }> = [];
  for (const entries of byName.values()) {
    entries.sort(
      (left, right) =>
        skillRootPriority(left.path) - skillRootPriority(right.path) ||
        left.path.localeCompare(right.path)
    );
    selected.push(entries[0]);
    if (entries.length > 1) {
      collisions.push({
        name: entries[0].name,
        paths: entries.map((entry) => entry.path),
      });
    }
  }
  return {
    skills: selected.sort((left, right) => left.name.localeCompare(right.name)),
    collisions,
  };
}
