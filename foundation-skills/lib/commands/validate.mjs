/**
 * validate — validate catalog coverage, contracts, and lockfile integrity.
 *
 * Checks:
 *   - Every skill in catalog.json has a SKILL.md foundation file
 *   - Every SKILL.md has valid frontmatter (name, description)
 *   - No foundation file references project-specific identifiers (no-project-context lint)
 *   - Every bootstrap-recipe.json has required fields
 *   - apex-skills.lock.json hashes match (if present)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog } from '../catalog-loader.mjs';
import { FOUNDATION_DIR } from '../paths.mjs';
import { readLockfile, verifyLockfile } from '../lockfile.mjs';

// Terms that should NEVER appear in foundation files (project-specific identifiers)
const BANNED_TERMS = [
  'MaxView', 'maxview', 'Maxim.TimeClock', 'TimeClock',
  'maxview-colors', 'MAXVIEW_DS',
  'infra/shared-async.tf',   // Apex-specific infra path (goes in adapter)
  'infra/pdf-processing.tf', // Apex-specific infra path
  'MUI', 'muiTheme',         // MaxView-specific (generic "MUI" is allowed only in adapters)
  'Roboto',                  // MaxView-specific font
];

// Terms allowed in foundations (generic framework references)
const ALLOWED_EXCEPTIONS = new Set([
  // e.g. 'MUI' in a comment saying "e.g. MUI or Bootstrap" is OK if in an adapter
]);

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fm;
}

export async function validate({ repoRoot = process.cwd(), quiet = false } = {}) {
  const errors   = [];
  const warnings = [];

  function err(msg) { errors.push(msg); if (!quiet) console.error(`  FAIL: ${msg}`); }
  function warn(msg) { warnings.push(msg); if (!quiet) console.warn(`  WARN: ${msg}`); }
  function ok(msg) { if (!quiet) console.log(`  OK:   ${msg}`); }

  if (!quiet) console.log('\nValidating @apex/skills foundations...\n');

  // Load catalog
  let catalog;
  try { catalog = loadCatalog(); } catch (e) { err(`Cannot load catalog: ${e.message}`); return { ok: false, errors, warnings }; }

  for (const entry of catalog.skills) {
    const { id } = entry;
    const skillDir = join(FOUNDATION_DIR, id);
    const skillMd  = join(skillDir, 'SKILL.md');

    // Foundation SKILL.md exists
    if (!existsSync(skillMd)) {
      err(`Missing foundation: ${id}/SKILL.md`);
      continue;
    }

    const content = readFileSync(skillMd, 'utf-8');

    // Valid frontmatter
    const fm = parseFrontmatter(content);
    if (!fm) {
      err(`${id}/SKILL.md: missing YAML frontmatter`);
    } else {
      if (!fm.name)        err(`${id}/SKILL.md: frontmatter missing "name"`);
      if (!fm.description) err(`${id}/SKILL.md: frontmatter missing "description"`);
    }

    // No-project-context lint
    for (const term of BANNED_TERMS) {
      if (content.includes(term)) {
        err(`${id}/SKILL.md: contains project-specific identifier "${term}" — move to adapter`);
      }
    }

    // Bootstrap recipe (warn if missing, not hard error)
    const recipePath = join(skillDir, 'bootstrap-recipe.json');
    if (!existsSync(recipePath)) {
      warn(`${id}: missing bootstrap-recipe.json (adapter bootstrapping will produce blank slots)`);
    } else {
      let recipe;
      try { recipe = JSON.parse(readFileSync(recipePath, 'utf-8')); } catch (e) {
        err(`${id}/bootstrap-recipe.json: invalid JSON — ${e.message}`);
        continue;
      }
      if (!recipe.scanScope) err(`${id}/bootstrap-recipe.json: missing "scanScope" field`);
    }

    ok(`${id}`);
  }

  // Lockfile integrity (if present)
  const lock = readLockfile(repoRoot);
  if (lock) {
    const { ok: hashOk, drifted } = verifyLockfile(lock, repoRoot);
    if (!hashOk) {
      warn(`Lockfile integrity: ${drifted.length} file(s) drifted: ${drifted.join(', ')}`);
    } else {
      ok('Lockfile integrity');
    }
  }

  if (!quiet) {
    console.log('');
    if (errors.length) {
      console.log(`Validation FAILED — ${errors.length} error(s), ${warnings.length} warning(s).`);
    } else {
      console.log(`Validation passed — ${warnings.length} warning(s).`);
    }
    console.log('');
  }

  return { ok: errors.length === 0, errors, warnings };
}
