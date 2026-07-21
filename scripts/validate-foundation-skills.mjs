#!/usr/bin/env node
/**
 * validate-foundation-skills.mjs
 *
 * CI/pre-commit script that validates the @apex/skills foundation package:
 *   - Every skill in catalog.json has a SKILL.md
 *   - Every SKILL.md has valid frontmatter (name, description)
 *   - No foundation file contains project-specific identifiers
 *   - Every foundation has a bootstrap-recipe.json
 *   - Every bootstrap-recipe.json is valid JSON with required fields
 *   - Catalog covers all expected skill count (>= 30)
 *
 * Exit code: 0 = pass, 1 = fail
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const FOUNDATION_DIR = join(REPO_ROOT, 'foundation-skills', 'foundation');
const CATALOG_PATH   = join(REPO_ROOT, 'foundation-skills', 'catalog.json');

// Terms that must NEVER appear in any foundation file
const BANNED_TERMS = [
  'MaxView', 'maxview', 'Maxim.TimeClock', 'TimeClock',
  'maxview-colors', 'MAXVIEW_DS',
  'infra/shared-async.tf',
  'infra/pdf-processing.tf',
  'Roboto',               // MaxView-specific font
  'MUI Material',         // MaxView-specific (plain "MUI" allowed as generic acronym)
  'figma-ui-knowledge-base',
];

// Exclusions for the no-project-context lint (adapter-template.md is allowed to reference these)
const SKIP_NO_PROJECT_LINT = new Set(['adapter-template.md']);

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

if (catalog.skills.length < 30) {
  err(`catalog.json has only ${catalog.skills.length} skills; expected >= 30`);
}

// 2. Validate each skill
for (const entry of catalog.skills) {
  // Catalog uses 'name' as the canonical identifier (not 'id')
  const id = entry.name;
  if (!id) {
    err(`Catalog entry missing "name" field: ${JSON.stringify(entry).slice(0, 80)}`);
    continue;
  }
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

  // No-project-context lint on SKILL.md (not on adapter-template.md)
  for (const term of BANNED_TERMS) {
    if (content.includes(term)) {
      err(`${id}/SKILL.md: contains project-specific term "${term}"`);
    }
  }

  // Bootstrap recipe
  const recipePath = join(skillDir, 'bootstrap-recipe.json');
  if (!existsSync(recipePath)) {
    warn(`${id}: missing bootstrap-recipe.json`);
  } else {
    let recipe;
    try { recipe = JSON.parse(readFileSync(recipePath, 'utf-8')); } catch (e) {
      err(`${id}/bootstrap-recipe.json: invalid JSON — ${e.message}`);
      continue;
    }
    if (!recipe.scanScope) err(`${id}/bootstrap-recipe.json: missing "scanScope"`);
    if (!recipe.description) warn(`${id}/bootstrap-recipe.json: missing "description"`);
    if (!Array.isArray(recipe.detectors)) err(`${id}/bootstrap-recipe.json: "detectors" must be an array`);
  }

  // Adapter template
  if (!existsSync(join(skillDir, 'adapter-template.md'))) {
    warn(`${id}: missing adapter-template.md`);
  }

  ok(id);
}

// 3. Check that every directory under foundation/ is in the catalog
try {
  const foundationDirs = readdirSync(FOUNDATION_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);
  const catalogIds = new Set(catalog.skills.map(s => s.name));
  for (const dir of foundationDirs) {
    if (!catalogIds.has(dir)) {
      warn(`foundation/${dir}/ exists but is not in catalog.json`);
    }
  }
} catch (e) {
  warn(`Could not list foundation/ directory: ${e.message}`);
}

console.log('');
if (errors > 0) {
  console.log(`Validation FAILED — ${errors} error(s), ${warnings} warning(s).`);
  process.exit(1);
} else {
  console.log(`Validation passed — ${warnings} warning(s).`);
  process.exit(0);
}
