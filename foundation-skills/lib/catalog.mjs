/**
 * Load and validate the package catalog (catalog.json).
 *
 * catalog.json shape:
 * {
 *   "suiteVersion": "0.1.0",
 *   "contractApiVersion": 1,
 *   "skills": [
 *     {
 *       "name": "ui-lab",
 *       "summary": "…",
 *       "scanScope": "targeted" | "full-repo",
 *       "foundationFiles": ["SKILL.md", …],
 *       "adapterFiles": ["SKILL.md", "apex-skill.json", "recipe.json"],
 *       "dependsOn": ["other-skill"],
 *       "supportingOwners": { "adr-template.md": "foundation", "rubric.md": "adapter" }
 *     }
 *   ]
 * }
 */
import path from 'node:path';
import { readJson } from './util.mjs';
import { CATALOG_NAME } from './layout.mjs';

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCOPES = new Set(['targeted', 'full-repo']);

export function loadCatalog(pkgRoot) {
  return readJson(path.join(pkgRoot, CATALOG_NAME));
}

export function findSkill(catalog, name) {
  return (catalog.skills ?? []).find((s) => s.name === name) ?? null;
}

export function listAdapterRuntimeFiles(skill) {
  const owners = skill?.supportingOwners ?? {};
  const runtimeFiles = [];

  for (const rel of skill?.adapterFiles ?? []) {
    if (rel === 'SKILL.md' || rel === 'recipe.json') continue;
    if (rel === 'apex-skill.json' || owners[rel] === 'adapter') {
      runtimeFiles.push(rel);
    }
  }

  return [...new Set(runtimeFiles)];
}

export function resolveSkillDependencyClosure(catalog, requestedSkills = []) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  const visit = (name, trail = []) => {
    const skill = findSkill(catalog, name);
    if (!skill) {
      const from = trail.at(-1);
      throw new Error(
        from
          ? `Skill "${from}" depends on unknown skill "${name}"`
          : `Unknown skill: ${name}`,
      );
    }
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Skill dependency cycle detected: ${[...trail, name].join(' -> ')}`);
    }

    visiting.add(name);
    for (const dependency of skill.dependsOn ?? []) {
      visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  };

  for (const name of requestedSkills) visit(name);
  return ordered;
}

/** Structural validation of the catalog. Returns an array of error strings. */
export function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object') return ['catalog.json is not an object'];
  if (!catalog.suiteVersion) errors.push('catalog.suiteVersion is required');
  if (!Array.isArray(catalog.skills)) return ['catalog.skills must be an array'];

  const seen = new Set();
  for (const s of catalog.skills) {
    const id = s?.name ?? '<unnamed>';
    if (!s.name || !KEBAB.test(s.name)) {
      errors.push(`skill "${id}" name must be kebab-case`);
    }
    if (seen.has(s.name)) errors.push(`duplicate skill name: ${s.name}`);
    seen.add(s.name);
    if (!SCOPES.has(s.scanScope)) {
      errors.push(`skill "${id}" scanScope must be one of ${[...SCOPES].join(', ')}`);
    }
    if (!Array.isArray(s.foundationFiles) || s.foundationFiles.length === 0) {
      errors.push(`skill "${id}" must declare at least one foundationFile`);
    }
    if (!Array.isArray(s.adapterFiles) || s.adapterFiles.length === 0) {
      errors.push(`skill "${id}" must declare at least one adapterFile`);
    }
  }

  // Dependency edges must resolve to known skills.
  for (const s of catalog.skills) {
    for (const dep of s.dependsOn ?? []) {
      if (!seen.has(dep)) errors.push(`skill "${s.name}" depends on unknown skill "${dep}"`);
    }
  }
  return errors;
}
