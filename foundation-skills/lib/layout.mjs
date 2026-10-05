/**
 * Canonical on-disk layout for both the package and a consuming repo.
 *
 * In the published package:
 *   foundation/<skill>/**        generic, project-agnostic foundation files
 *   adapters/<skill>/**          adapter template + apex-skill.json + recipe.json
 *   catalog.json                 skill catalog / manifest
 *   schemas/**                   JSON schemas
 *
 * In a consuming repo (after install):
 *   <skillRoot>/<skill>/**       fenced SKILL.md (managed region + project tail)
 *                                + companion files (fully managed)
 *   .apex/config.json            APEX authorization cache (unchanged)
 *   .apex/backups/<skill>/**     backups of in-fence edits before overwrite
 *   apex-skills.lock.json        version + integrity lockfile
 */
import path from 'node:path';
import { LEGACY_SKILL_ROOT, normalizeSkillRoot } from './skillRoot.mjs';

export const LOCKFILE_NAME = 'apex-skills.lock.json';
export const CONTRACT_NAME = 'apex-skill.json';
export const RECIPE_NAME = 'recipe.json';
export const CATALOG_NAME = 'catalog.json';

/** @deprecated v1 layout — kept for migration reads only */
export const LEGACY_VENDOR_DIR = '.apex/foundation';

/** @deprecated Use the root recorded in apex-skills.lock.json. */
export const ADAPTER_DIR = LEGACY_SKILL_ROOT;
export const BACKUP_DIR = '.apex/backups';
export const APEX_DIR = '.apex';

export const CONTRACT_API_VERSION = 1;

export function pkgFoundationDir(pkgRoot, skill) {
  return path.join(pkgRoot, 'foundation', skill);
}
export function pkgAdapterDir(pkgRoot, skill) {
  return path.join(pkgRoot, 'adapters', skill);
}
export function repoAdapterDir(repoRoot, skill, skillRoot = ADAPTER_DIR) {
  return path.join(repoRoot, normalizeSkillRoot(skillRoot), skill);
}
export function repoBackupDir(repoRoot, skill) {
  return path.join(repoRoot, BACKUP_DIR, skill);
}
export function repoLegacyVendorDir(repoRoot, skill) {
  return path.join(repoRoot, LEGACY_VENDOR_DIR, skill);
}
export function repoLockfilePath(repoRoot) {
  return path.join(repoRoot, LOCKFILE_NAME);
}
