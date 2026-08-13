/**
 * apex-skills.lock.json read/write.
 *
 * v3 shape:
 * {
 *   "lockfileVersion": 3,
 *   "suiteVersion": "1.1.0",
 *   "package": "@apex/skills",
 *   "skillRoot": ".agents/skills",
 *   "generatedAt": "…",           // omitted from the integrity hash
 *   "skills": {
 *     "ui-lab": {
 *       "contractRange": ">=0.1.0",
 *       "managedRegionHash": "<sha256 of foundation frontmatter + fenced region>",
 *       "managedFiles": {
 *         ".agents/skills/ui-lab/companion.json": "<sha256>"
 *       },
 *       "adapterScaffolded": true
 *     }
 *   }
 * }
 *
 * v1 lockfiles (vendored: { ".apex/foundation/...": hash }) are still readable
 * so install can migrate them to the current write format.
 * v3 is written only for non-legacy roots; legacy `.cursor/skills` stays v2
 * so already-published 2.0.x CLIs keep reading those lockfiles.
 */
import fs from 'node:fs';
import { readJson, stableStringify, sha256 } from './util.mjs';
import { repoLockfilePath, LOCKFILE_NAME } from './layout.mjs';
import { LEGACY_SKILL_ROOT, normalizeSkillRoot } from './skillRoot.mjs';

export const LOCKFILE_VERSION = 3;
export const LOCKFILE_VERSION_V2 = 2;
export const LOCKFILE_VERSION_V1 = 1;
const SUPPORTED_LOCKFILE_VERSIONS = new Set([
  LOCKFILE_VERSION,
  LOCKFILE_VERSION_V2,
]);

export function readLockfile(repoRoot) {
  const p = repoLockfilePath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
}

/** True when the lockfile uses the pre-merge v1 shape. */
export function isV1Lockfile(lock) {
  if (!lock) return false;
  if (lock.lockfileVersion === LOCKFILE_VERSION_V1) return true;
  if (lock.lockfileVersion !== undefined && lock.lockfileVersion !== null) {
    return false;
  }
  // Heuristic: any skill still carrying a `vendored` map is v1-shaped.
  return Object.values(lock.skills ?? {}).some(
    (s) => s && s.vendored && !s.managedRegionHash
  );
}

export function emptyLockfile(
  suiteVersion,
  pkgName,
  skillRoot = LEGACY_SKILL_ROOT
) {
  const lock = {
    lockfileVersion: lockfileVersionForRoot(skillRoot),
    suiteVersion,
    package: pkgName,
    skills: {},
  };
  applyLockfileRoot(lock, skillRoot);
  return lock;
}

export function lockfileVersionForRoot(skillRoot) {
  return normalizeSkillRoot(skillRoot) === LEGACY_SKILL_ROOT
    ? LOCKFILE_VERSION_V2
    : LOCKFILE_VERSION;
}

/** v3 + skillRoot only when the catalog is not the legacy Cursor root. */
export function applyLockfileRoot(lock, skillRoot) {
  const root = normalizeSkillRoot(skillRoot);
  lock.lockfileVersion = lockfileVersionForRoot(root);
  if (root === LEGACY_SKILL_ROOT) {
    delete lock.skillRoot;
  } else {
    lock.skillRoot = root;
  }
  return lock;
}

/**
 * Deterministic integrity hash of the lockfile content, excluding volatile
 * fields (generatedAt) so the same install produces the same hash.
 */
export function lockfileIntegrity(lock) {
  const { generatedAt, integrity, ...rest } = lock;
  return sha256(stableStringify(rest));
}

export function serializeLockfile(lock) {
  const withIntegrity = { ...lock, integrity: lockfileIntegrity(lock) };
  return stableStringify(withIntegrity);
}

/** Validate a lockfile before trusting its ownership hashes or installed version. */
export function verifyLockfileIntegrity(lock) {
  if (!lock || typeof lock !== 'object') {
    return { valid: false, error: 'Lockfile is not an object' };
  }
  if (isV1Lockfile(lock)) {
    return { valid: true, error: null };
  }
  if (!SUPPORTED_LOCKFILE_VERSIONS.has(lock.lockfileVersion)) {
    return {
      valid: false,
      error: `Unsupported lockfile version: ${lock.lockfileVersion ?? 'missing'}`,
    };
  }
  if (lock.skillRoot != null) {
    try {
      normalizeSkillRoot(lock.skillRoot);
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }
  if (typeof lock.integrity !== 'string' || !lock.integrity) {
    return { valid: false, error: 'Lockfile integrity is missing' };
  }
  if (lock.integrity !== lockfileIntegrity(lock)) {
    return { valid: false, error: 'Lockfile integrity mismatch' };
  }
  return { valid: true, error: null };
}

export { LOCKFILE_NAME };
