/**
 * apex-skills.lock.json read/write.
 *
 * v2 shape:
 * {
 *   "lockfileVersion": 2,
 *   "suiteVersion": "1.1.0",
 *   "package": "@apex/skills",
 *   "generatedAt": "…",           // omitted from the integrity hash
 *   "skills": {
 *     "ui-lab": {
 *       "contractRange": ">=0.1.0",
 *       "managedRegionHash": "<sha256 of foundation frontmatter + fenced region>",
 *       "managedFiles": {
 *         ".cursor/skills/ui-lab/companion.json": "<sha256>"
 *       },
 *       "adapterScaffolded": true
 *     }
 *   }
 * }
 *
 * v1 lockfiles (vendored: { ".apex/foundation/...": hash }) are still readable
 * so install can migrate them to v2.
 */
import fs from 'node:fs';
import { readJson, stableStringify, sha256 } from './util.mjs';
import { repoLockfilePath, LOCKFILE_NAME } from './layout.mjs';

export const LOCKFILE_VERSION = 2;
export const LOCKFILE_VERSION_V1 = 1;

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
  return Object.values(lock.skills ?? {}).some((s) => s && s.vendored && !s.managedRegionHash);
}

export function emptyLockfile(suiteVersion, pkgName) {
  return {
    lockfileVersion: LOCKFILE_VERSION,
    suiteVersion,
    package: pkgName,
    skills: {},
  };
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
  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    return {
      valid: false,
      error: `Unsupported lockfile version: ${lock.lockfileVersion ?? 'missing'}`,
    };
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
