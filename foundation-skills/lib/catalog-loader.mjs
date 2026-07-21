/**
 * catalog-loader — reads and validates catalog.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { CATALOG_PATH } from './paths.mjs';

let _catalog = null;

/** Load and cache catalog.json from the package root. */
export function loadCatalog() {
  if (_catalog) return _catalog;
  if (!existsSync(CATALOG_PATH)) throw new Error(`catalog.json not found at ${CATALOG_PATH}`);
  _catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
  return _catalog;
}

/** Invalidate cache (for tests). */
export function _resetCatalog() { _catalog = null; }

/**
 * Find a skill entry by id.
 * @returns {object|null}
 */
export function getSkillEntry(id) {
  const catalog = loadCatalog();
  return catalog.skills.find(s => s.id === id) ?? null;
}

/** Returns all skill ids. */
export function allSkillIds() {
  return loadCatalog().skills.map(s => s.id);
}
