/**
 * apex-skills.lock.json read/write.
 *
 * {
 *   "lockfileVersion": 1,
 *   "suiteVersion": "0.1.0",
 *   "package": "@apex/skills",
 *   "generatedAt": "…",           // omitted from the integrity hash
 *   "skills": {
 *     "ui-lab": {
 *       "contractRange": "^0.1.0",
 *       "vendored": { ".apex/foundation/ui-lab/SKILL.md": "<sha256>" },
 *       "adapterScaffolded": true
 *     }
 *   }
 * }
 */
import fs from 'node:fs';
import { readJson, stableStringify, sha256 } from './util.mjs';
import { repoLockfilePath, LOCKFILE_NAME } from './layout.mjs';

export const LOCKFILE_VERSION = 1;

export function readLockfile(repoRoot) {
  const p = repoLockfilePath(repoRoot);
  if (!fs.existsSync(p)) return null;
  return readJson(p);
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

export { LOCKFILE_NAME };
