/**
 * Transactional, repo-local install.
 *
 * For each selected skill:
 *   - vendor the generic foundation into .apex/foundation/<skill>/ (managed, replaced)
 *   - scaffold a pre-filled adapter into .cursor/skills/<skill>/ ONLY if absent
 *     (never clobber a pre-existing team adapter)
 *   - record versions, contract range, and file hashes in apex-skills.lock.json
 *
 * Aborts before writing on: unknown skill, unsupported contract range, path
 * traversal, or modified managed foundation files (checksum drift).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  hashFile, writeTextFile, normalizeText, sha256, assertWithin, toPosix, ensureDir,
} from './util.mjs';
import {
  pkgFoundationDir, repoVendorDir, repoAdapterDir, VENDOR_DIR, ADAPTER_DIR,
} from './layout.mjs';
import { listFilesRel } from './util.mjs';
import { loadCatalog, findSkill } from './catalog.mjs';
import { readLockfile, emptyLockfile, serializeLockfile } from './lockfile.mjs';
import { bootstrapSkill } from './bootstrap.mjs';
import { satisfies } from './semver.mjs';

/**
 * Plan an install without writing. Returns { actions, errors, warnings }.
 */
export function planInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const catalog = loadCatalog(pkgRoot);
  const errors = [];
  const warnings = [];
  const actions = [];

  const existingLock = readLockfile(repoRoot);
  if (existingLock && existingLock.suiteVersion) {
    // Guard: managed foundation files must not have been hand-edited.
    for (const [skill, info] of Object.entries(existingLock.skills ?? {})) {
      for (const [relPath, expected] of Object.entries(info.vendored ?? {})) {
        const abs = path.join(repoRoot, relPath);
        const actual = hashFile(abs);
        if (actual && actual !== expected) {
          errors.push(`Managed foundation file modified: ${relPath} (checksum drift)`);
        }
      }
    }
  }

  for (const name of skillNames) {
    const skill = findSkill(catalog, name);
    if (!skill) {
      errors.push(`Unknown skill: ${name}`);
      continue;
    }

    // Contract range check against the suite version being installed.
    const contract = readContractTemplate(pkgRoot, name);
    if (contract?.foundation?.range && !satisfies(catalog.suiteVersion, contract.foundation.range)) {
      errors.push(
        `Skill "${name}" contract range ${contract.foundation.range} not satisfied by suite ${catalog.suiteVersion}`,
      );
      continue;
    }

    // Vendored foundation files (always replaced).
    const foundationDir = pkgFoundationDir(pkgRoot, name);
    const vendored = {};
    for (const rel of listFilesRel(foundationDir)) {
      const destRel = toPosix(path.join(VENDOR_DIR, name, rel));
      assertWithin(repoRoot, destRel);
      const text = normalizeText(fs.readFileSync(path.join(foundationDir, rel), 'utf8'));
      vendored[destRel] = { text, hash: sha256(text) };
    }

    // Adapter: scaffold only if absent.
    const adapterDest = repoAdapterDir(repoRoot, name);
    const adapterExists = fs.existsSync(adapterDest) && fs.readdirSync(adapterDest).length > 0;
    let adapterFiles = {};
    if (!adapterExists) {
      const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
      for (const [rel, text] of Object.entries(boot.files)) {
        const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
        assertWithin(repoRoot, destRel);
        adapterFiles[destRel] = text;
      }
    } else {
      warnings.push(`Adapter for "${name}" already exists — left untouched`);
    }

    actions.push({ skill: name, vendored, adapterFiles, adapterScaffolded: !adapterExists, contract });
  }

  return { catalog, actions, errors, warnings };
}

/** Execute a previously computed plan. Writes files and the lockfile. */
export function executeInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const { catalog, actions, errors, warnings } = planInstall(pkgRoot, repoRoot, skillNames, opts);
  if (errors.length) {
    const err = new Error('Install aborted:\n  - ' + errors.join('\n  - '));
    err.errors = errors;
    throw err;
  }
  if (opts.dryRun) {
    return { dryRun: true, actions, warnings, wrote: [] };
  }

  const wrote = [];
  const lock = readLockfile(repoRoot) ?? emptyLockfile(catalog.suiteVersion, catalog.package ?? '@apex/skills');
  lock.suiteVersion = catalog.suiteVersion;

  for (const action of actions) {
    const vendoredHashes = {};
    for (const [destRel, { text, hash }] of Object.entries(action.vendored)) {
      writeTextFile(path.join(repoRoot, destRel), text);
      vendoredHashes[destRel] = hash;
      wrote.push(destRel);
    }
    if (action.adapterScaffolded) {
      for (const [destRel, text] of Object.entries(action.adapterFiles)) {
        writeTextFile(path.join(repoRoot, destRel), text);
        wrote.push(destRel);
      }
    }
    lock.skills[action.skill] = {
      contractRange: action.contract?.foundation?.range ?? null,
      vendored: vendoredHashes,
      adapterScaffolded: action.adapterScaffolded || Boolean(lock.skills[action.skill]?.adapterScaffolded),
    };
  }

  const lockText = serializeLockfile({ ...lock, generatedAt: new Date().toISOString() });
  ensureDir(repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'apex-skills.lock.json'), lockText, 'utf8');
  wrote.push('apex-skills.lock.json');

  return { dryRun: false, actions, warnings, wrote };
}

function readContractTemplate(pkgRoot, skill) {
  const p = path.join(pkgRoot, 'adapters', skill, 'apex-skill.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
