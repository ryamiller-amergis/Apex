/**
 * Validate the foundation-skills package itself:
 *  - catalog structural validity + coverage (catalog <-> folders)
 *  - each foundation SKILL.md has valid kebab frontmatter
 *  - each adapter has a valid apex-skill.json contract with a supported apiVersion
 *  - no unresolved slot directives reference unknown detectors
 *  - no-project-context lint: foundation files must not mention foreign projects
 *  - every nested supporting file has a declared owner in the catalog
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, listFilesRel } from './util.mjs';
import { loadCatalog, validateCatalog, findSkill } from './catalog.mjs';
import { validateContract } from './contract.mjs';
import { DETECTORS } from './detectors.mjs';

// Foreign-project identifiers that must never appear in a generic foundation.
const FOREIGN_TOKENS = [/maxview/i, /recruitcare/i, /timeclock/i, /\berecruit\b/i];

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function validatePackage(pkgRoot) {
  const errors = [];
  const warnings = [];

  let catalog;
  try {
    catalog = loadCatalog(pkgRoot);
  } catch (e) {
    return { ok: false, errors: [`Cannot load catalog.json: ${e.message}`], warnings };
  }

  errors.push(...validateCatalog(catalog));

  const foundationRoot = path.join(pkgRoot, 'foundation');
  const adaptersRoot = path.join(pkgRoot, 'adapters');

  const foundationDirs = listDirs(foundationRoot);
  const adapterDirs = listDirs(adaptersRoot);
  const catalogNames = new Set((catalog.skills ?? []).map((s) => s.name));

  // Coverage: every folder must be catalogued and vice versa.
  for (const d of foundationDirs) {
    if (!catalogNames.has(d)) errors.push(`foundation/${d} is not listed in catalog.json`);
  }
  for (const name of catalogNames) {
    if (!foundationDirs.includes(name)) errors.push(`catalog skill "${name}" has no foundation/${name} directory`);
    if (!adapterDirs.includes(name)) errors.push(`catalog skill "${name}" has no adapters/${name} directory`);
  }

  for (const skill of catalog.skills ?? []) {
    const fDir = path.join(foundationRoot, skill.name);
    const aDir = path.join(adaptersRoot, skill.name);

    // Foundation frontmatter + no-project-context lint.
    for (const rel of listFilesRel(fDir)) {
      const abs = path.join(fDir, rel);
      const text = fs.readFileSync(abs, 'utf8');
      if (rel === 'SKILL.md') {
        const fm = parseFrontmatter(text);
        if (!fm.name || !KEBAB.test(fm.name)) errors.push(`foundation/${skill.name}/SKILL.md name must be kebab-case`);
        if (!fm.description) warnings.push(`foundation/${skill.name}/SKILL.md missing description`);
      }
      for (const tok of FOREIGN_TOKENS) {
        if (tok.test(text)) {
          errors.push(`foundation/${skill.name}/${rel} contains foreign-project reference matching ${tok}`);
          break;
        }
      }
    }

    // Adapter contract.
    const contractPath = path.join(aDir, 'apex-skill.json');
    if (!fs.existsSync(contractPath)) {
      errors.push(`adapters/${skill.name}/apex-skill.json is missing`);
    } else {
      try {
        const contract = readJson(contractPath);
        errors.push(...validateContract(contract, { skillName: skill.name }));
      } catch (e) {
        errors.push(`adapters/${skill.name}/apex-skill.json invalid JSON: ${e.message}`);
      }
    }

    // Recipe detector references + supporting-file owners.
    const recipePath = path.join(aDir, 'recipe.json');
    if (fs.existsSync(recipePath)) {
      try {
        const recipe = readJson(recipePath);
        for (const det of recipe.detectors ?? []) {
          if (!DETECTORS[det]) errors.push(`adapters/${skill.name}/recipe.json references unknown detector "${det}"`);
        }
      } catch (e) {
        errors.push(`adapters/${skill.name}/recipe.json invalid JSON: ${e.message}`);
      }
    }

    // Supporting files (non-SKILL.md) must have a declared owner.
    const owners = skill.supportingOwners ?? {};
    for (const rel of listFilesRel(fDir).concat(listFilesRel(aDir))) {
      if (rel === 'SKILL.md' || rel === 'apex-skill.json' || rel === 'recipe.json') continue;
      if (!owners[rel]) {
        warnings.push(`skill "${skill.name}" supporting file "${rel}" has no declared owner in supportingOwners`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 1) continue;
    fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}
