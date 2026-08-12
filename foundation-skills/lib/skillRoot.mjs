import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_SKILL_ROOT = '.cursor/skills';
export const AGENT_SKILL_ROOT = '.agents/skills';
export const KNOWN_SKILL_ROOTS = Object.freeze([
  AGENT_SKILL_ROOT,
  LEGACY_SKILL_ROOT,
]);

/**
 * Normalize a repository-relative canonical skill root.
 *
 * Roots are persisted with POSIX separators so lockfiles remain portable.
 */
export function normalizeSkillRoot(
  value,
  { fallback = LEGACY_SKILL_ROOT } = {}
) {
  const raw = String(value ?? fallback)
    .trim()
    .replaceAll('\\', '/');
  if (!raw) throw new Error('Skill root must not be empty');
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`Skill root must be repository-relative: ${value}`);
  }

  const normalized = path.posix
    .normalize(raw)
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`Skill root must stay within the repository: ${value}`);
  }
  return normalized;
}

/**
 * Resolve the canonical root for an operation.
 *
 * Explicit CLI/API input wins. Existing lockfiles keep their recorded root;
 * v2 lockfiles created before root support remain legacy `.cursor/skills`
 * installations.
 */
export function resolveSkillRoot({ requestedRoot = null, lock = null } = {}) {
  if (requestedRoot != null) return normalizeSkillRoot(requestedRoot);
  if (lock?.skillRoot != null) return normalizeSkillRoot(lock.skillRoot);
  return LEGACY_SKILL_ROOT;
}

export function resolveRepoSkillRoot(
  repoRoot,
  { requestedRoot = null, lock = null } = {}
) {
  if (requestedRoot != null || lock) {
    return resolveSkillRoot({ requestedRoot, lock });
  }
  if (fs.existsSync(path.join(repoRoot, AGENT_SKILL_ROOT))) {
    return AGENT_SKILL_ROOT;
  }
  return LEGACY_SKILL_ROOT;
}

export function skillRootWithTrailingSlash(value) {
  return `${normalizeSkillRoot(value)}/`;
}

export function alternateKnownSkillRoots(canonicalRoot) {
  const canonical = normalizeSkillRoot(canonicalRoot);
  return KNOWN_SKILL_ROOTS.filter((candidate) => candidate !== canonical);
}

export function findSkillRootCollisions(repoRoot, skillNames, canonicalRoot) {
  const canonical = normalizeSkillRoot(canonicalRoot);
  const roots = [...new Set([canonical, ...KNOWN_SKILL_ROOTS])];
  const collisions = [];

  for (const skill of [...new Set(skillNames ?? [])]) {
    const presentRoots = roots.filter((root) =>
      fs.existsSync(path.join(repoRoot, root, skill))
    );
    const physicalRoots = new Set(
      presentRoots.map((root) =>
        fs.realpathSync(path.join(repoRoot, root, skill))
      )
    );
    if (
      physicalRoots.size > 1 ||
      (presentRoots.length > 0 && !presentRoots.includes(canonical))
    ) {
      collisions.push({ skill, canonicalRoot: canonical, roots: presentRoots });
    }
  }
  return collisions;
}
