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
 *   .apex/foundation/<skill>/**  vendored immutable foundation (managed)
 *   .cursor/skills/<skill>/**    editable adapter (scaffolded once, never clobbered)
 *   apex-skills.lock.json        version + integrity lockfile
 */
import path from 'node:path';

export const LOCKFILE_NAME = 'apex-skills.lock.json';
export const CONTRACT_NAME = 'apex-skill.json';
export const RECIPE_NAME = 'recipe.json';
export const CATALOG_NAME = 'catalog.json';

export const VENDOR_DIR = '.apex/foundation';
export const ADAPTER_DIR = '.cursor/skills';

export const CONTRACT_API_VERSION = 1;

export function pkgFoundationDir(pkgRoot, skill) {
  return path.join(pkgRoot, 'foundation', skill);
}
export function pkgAdapterDir(pkgRoot, skill) {
  return path.join(pkgRoot, 'adapters', skill);
}
export function repoVendorDir(repoRoot, skill) {
  return path.join(repoRoot, VENDOR_DIR, skill);
}
export function repoAdapterDir(repoRoot, skill) {
  return path.join(repoRoot, ADAPTER_DIR, skill);
}
export function repoLockfilePath(repoRoot) {
  return path.join(repoRoot, LOCKFILE_NAME);
}
