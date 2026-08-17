#!/usr/bin/env node
/**
 * validate-foundation-skills.mjs
 *
 * CI/pre-commit script that validates the @apex/skills foundation package:
 *   - Every skill in catalog.json has foundation/<name>/SKILL.md with valid
 *     frontmatter (name, description)
 *   - Every skill has adapters/<name>/{SKILL.md, apex-skill.json, recipe.json}
 *   - Every file the catalog declares in foundationFiles / adapterFiles exists
 *   - recipe.json is valid JSON with skill, scanScope, detectors[], slots
 *   - apex-skill.json matches the skill name and the catalog contractApiVersion
 *   - Every catalog tier is a recognised value
 *   - No *shippable* foundation or adapter file contains project-specific
 *     identifiers (both layers land in the consumer repo)
 *   - Catalog is non-empty and each entry is structurally valid
 *
 * Warnings cover manifest drift that does not break an install: files on disk
 * that the catalog does not declare, and skill directories not in the catalog.
 *
 * Exit code: 0 = pass, 1 = fail
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FOUNDATION_DIR = join(REPO_ROOT, 'foundation-skills', 'foundation');
const ADAPTER_DIR    = join(REPO_ROOT, 'foundation-skills', 'adapters');
const CATALOG_PATH   = join(REPO_ROOT, 'foundation-skills', 'catalog.json');

// Terms that must NEVER appear in a shipped foundation or adapter template
const BANNED_TERMS = [
  'MaxView', 'maxview', 'Maxim.TimeClock', 'TimeClock',
  'maxview-colors', 'MAXVIEW_DS',
  'infra/shared-async.tf',
  'infra/pdf-processing.tf',
  'Roboto',               // MaxView-specific font
  'MUI Material',         // MaxView-specific (plain "MUI" allowed as generic acronym)
  'figma-ui-knowledge-base',
];

// Only text files are worth scanning for project leakage.
const LINTABLE = /\.(md|json|ya?ml|txt)$/i;

// Recognised catalog tiers. Absent tier means "shippable".
const VALID_TIERS = new Set(['shippable', 'apex-only']);

// Adapter files every skill must ship, regardless of what the catalog declares.
const REQUIRED_ADAPTER_FILES = ['SKILL.md', 'apex-skill.json', 'recipe.json'];

let errors = 0;
let warnings = 0;

function err(msg)  { errors++;   console.error(`  FAIL: ${msg}`); }
function warn(msg) { warnings++; console.warn(`  WARN: ${msg}`); }
function ok(msg)   {             console.log(`  OK:   ${msg}`);  }

function parseFrontmatter(content) {
  // Normalize CRLF → LF so the regex works on Windows
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

console.log('\nValidating @apex/skills foundation package...\n');

// 1. Load catalog
let catalog;
try {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf-8'));
} catch (e) {
  err(`Cannot load catalog.json: ${e.message}`);
  process.exit(1);
}

if (catalog.skills.length === 0) {
  err('catalog.json has no skills');
} else {
  ok(`catalog.json lists ${catalog.skills.length} skill(s)`);
}

// 2. Validate each skill
for (const entry of catalog.skills) {
  // Catalog uses 'name' as the canonical identifier (not 'id')
  const id = entry.name;
  if (!id) {
    err(`Catalog entry missing "name" field: ${JSON.stringify(entry).slice(0, 80)}`);
    continue;
  }
  const errorsBefore = errors;
  const skillDir = join(FOUNDATION_DIR, id);
  const skillMd  = join(skillDir, 'SKILL.md');

  if (!existsSync(skillMd)) {
    err(`${id}: missing foundation/SKILL.md`);
    continue;
  }

  const content = readFileSync(skillMd, 'utf-8');
  const fm      = parseFrontmatter(content);

  if (!fm) {
    err(`${id}/SKILL.md: no YAML frontmatter`);
  } else {
    if (!fm.name)        err(`${id}/SKILL.md: frontmatter missing "name"`);
    if (!fm.description) err(`${id}/SKILL.md: frontmatter missing "description"`);
  }

  const tier = entry.tier ?? 'shippable';
  if (!VALID_TIERS.has(tier)) {
    err(`${id}: unknown tier "${tier}" (expected ${[...VALID_TIERS].join(' or ')})`);
  }

  const adapterSkillDir = join(ADAPTER_DIR, id);
  if (!existsSync(adapterSkillDir)) {
    err(`${id}: missing adapters/${id}/`);
    continue;
  }

  // Every file the catalog promises must actually be on disk, in both layers.
  // The catalog is the published manifest, so a broken promise is an error.
  // dirLabel is the on-disk directory; catalogKey is the catalog.json field.
  const layers = [
    { dirLabel: 'foundation', catalogKey: 'foundationFiles', dir: skillDir,        declared: entry.foundationFiles ?? [] },
    { dirLabel: 'adapters',   catalogKey: 'adapterFiles',    dir: adapterSkillDir, declared: entry.adapterFiles    ?? [] },
  ];

  // Every file the catalog promises must actually be on disk, in both layers.
  // The catalog is the published manifest, so a broken promise is an error.
  for (const { dirLabel, catalogKey, dir, declared } of layers) {
    for (const rel of declared) {
      if (!existsSync(join(dir, rel))) {
        err(`${id}: catalog ${catalogKey} lists "${rel}" but ${dirLabel}/${id}/${rel} does not exist`);
      }
    }
  }

  // Files present but undeclared still ship (the installer vendors by directory
  // listing), so this is manifest drift rather than a broken install.
  for (const { dirLabel, catalogKey, dir, declared } of layers) {
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || declared.includes(file.name)) continue;
      warn(`${id}: ${dirLabel}/${id}/${file.name} exists but is not in catalog ${catalogKey}`);
    }
  }

  for (const required of REQUIRED_ADAPTER_FILES) {
    if (!existsSync(join(adapterSkillDir, required))) {
      err(`${id}: missing adapters/${id}/${required}`);
    }
  }

  // Bootstrap recipe — lives beside the adapter template as recipe.json.
  const recipePath = join(adapterSkillDir, 'recipe.json');
  if (existsSync(recipePath)) {
    let recipe;
    try { recipe = JSON.parse(readFileSync(recipePath, 'utf-8')); } catch (e) {
      err(`${id}/recipe.json: invalid JSON — ${e.message}`);
      recipe = null;
    }
    if (recipe) {
      if (recipe.skill !== id) {
        err(`${id}/recipe.json: "skill" is "${recipe.skill}" but should be "${id}"`);
      }
      if (!recipe.scanScope) err(`${id}/recipe.json: missing "scanScope"`);
      if (!Array.isArray(recipe.detectors)) {
        err(`${id}/recipe.json: "detectors" must be an array`);
      }
      if (!recipe.slots || typeof recipe.slots !== 'object' || Array.isArray(recipe.slots)) {
        err(`${id}/recipe.json: "slots" must be an object`);
      }
      if (recipe.scanScope === 'targeted' && !Array.isArray(recipe.targetedGlobs)) {
        err(`${id}/recipe.json: scanScope "targeted" requires "targetedGlobs"`);
      }
    }
  }

  // Compatibility contract.
  const contractPath = join(adapterSkillDir, 'apex-skill.json');
  if (existsSync(contractPath)) {
    let contract;
    try { contract = JSON.parse(readFileSync(contractPath, 'utf-8')); } catch (e) {
      err(`${id}/apex-skill.json: invalid JSON — ${e.message}`);
      contract = null;
    }
    if (contract) {
      if (contract.skill !== id) {
        err(`${id}/apex-skill.json: "skill" is "${contract.skill}" but should be "${id}"`);
      }
      if (contract.apiVersion !== catalog.contractApiVersion) {
        err(`${id}/apex-skill.json: apiVersion ${contract.apiVersion} does not match ` +
            `catalog contractApiVersion ${catalog.contractApiVersion}`);
      }
      if (!contract.foundation?.range) {
        err(`${id}/apex-skill.json: missing foundation.range`);
      }
    }
  }

  // No-project-context lint. Both layers land in a consumer repo, so both must
  // be project-agnostic. apex-only skills never ship, so they are exempt.
  if (tier === 'shippable') {
    for (const { dirLabel, dir } of layers) {
      for (const file of readdirSync(dir, { withFileTypes: true })) {
        if (!file.isFile() || !LINTABLE.test(file.name)) continue;
        const text = readFileSync(join(dir, file.name), 'utf-8');
        for (const term of BANNED_TERMS) {
          if (text.includes(term)) {
            err(`${dirLabel}/${id}/${file.name}: contains project-specific term "${term}"`);
          }
        }
      }
    }
  }

  // Only claim OK when this skill contributed no errors.
  if (errors === errorsBefore) {
    ok(tier === 'apex-only' ? `${id} (apex-only)` : id);
  }
}

// 3. Check that every skill directory on disk is registered in the catalog.
//    An unregistered skill is invisible to the admin UI and to install/update.
const catalogIds = new Set(catalog.skills.map(s => s.name));
for (const [label, dir] of [['foundation', FOUNDATION_DIR], ['adapters', ADAPTER_DIR]]) {
  try {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    for (const name of dirs) {
      if (!catalogIds.has(name)) {
        warn(`${label}/${name}/ exists but is not in catalog.json`);
      }
    }
  } catch (e) {
    warn(`Could not list ${label}/ directory: ${e.message}`);
  }
}

console.log('');
if (errors > 0) {
  console.log(`Validation FAILED — ${errors} error(s), ${warnings} warning(s).`);
  process.exit(1);
} else {
  console.log(`Validation passed — ${warnings} warning(s).`);
  process.exit(0);
}
