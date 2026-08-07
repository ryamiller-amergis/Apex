/**
 * Transactional, repo-local install (three-zone SKILL.md layout).
 *
 * For each selected skill:
 *   - write .cursor/skills/<skill>/SKILL.md with:
 *       foundation fence (APEX:managed) + adapter zone (APEX:adapter) + project notes
 *   - copy companion foundation files (non-SKILL.md) alongside, always replaced
 *   - if an unfenced SKILL.md already exists, leave it untouched and warn
 *   - if a fenced SKILL.md exists, replace foundation ownership only; adapter
 *     and project notes remain project-owned
 *   - explicit --fill may fill unfilled adapter slots without replacing prose
 *   - back up foundation-fence drift to .apex/backups/<skill>/ before overwriting
 *   - migrate v1 (.apex/foundation) installs for ONLY the skills being installed
 *   - record managedRegionHash + managedFiles hashes in apex-skills.lock.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  hashFile, writeTextFile, normalizeText, sha256, assertWithin, toPosix, ensureDir,
  listFilesRel,
} from './util.mjs';
import {
  pkgFoundationDir, repoAdapterDir, repoLegacyVendorDir,
  ADAPTER_DIR, LEGACY_VENDOR_DIR, BACKUP_DIR,
} from './layout.mjs';
import { loadCatalog, findSkill, listAdapterRuntimeFiles } from './catalog.mjs';
import {
  readLockfile, emptyLockfile, serializeLockfile, isV1Lockfile,
  verifyLockfileIntegrity, LOCKFILE_VERSION,
} from './lockfile.mjs';
import { bootstrapSkill } from './bootstrap.mjs';
import { satisfies } from './semver.mjs';
import {
  compose, composeAdapter, composeManaged, splice, spliceAdapter, spliceFoundation,
  hashManaged, hasFence, inspectFences, splitZones,
} from './managedRegion.mjs';
import { mergeAdapterRegions } from './adapterMerge.mjs';
import { withInstallTransaction } from './installTransaction.mjs';

/**
 * Plan an install without writing. Returns { actions, errors, warnings }.
 */
export function planInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const catalog = loadCatalog(pkgRoot);
  const errors = [];
  const warnings = [];
  const actions = [];

  const existingLock = readLockfile(repoRoot);

  if (existingLock && !isV1Lockfile(existingLock)) {
    const integrity = verifyLockfileIntegrity(existingLock);
    if (!integrity.valid) {
      errors.push(`Invalid apex-skills.lock.json: ${integrity.error}`);
      return { catalog, actions, errors, warnings };
    }
    for (const [skill, info] of Object.entries(existingLock.skills ?? {})) {
      if (!findSkill(catalog, skill)) {
        errors.push(`Lockfile contains unknown skill: ${skill}`);
        continue;
      }
      if (!info?.managedRegionHash) continue;
      const skillMd = assertAdapterManagedPath(
        repoRoot,
        skill,
        path.join(ADAPTER_DIR, skill, 'SKILL.md'),
      );
      if (!fs.existsSync(skillMd)) continue;
      const actual = hashManaged(fs.readFileSync(skillMd, 'utf8'));
      if (actual && actual !== info.managedRegionHash) {
        warnings.push(
          `Foundation fence drift for "${skill}" — will back up to ${BACKUP_DIR}/${skill}/ before updating`,
        );
      }
      for (const [relPath, expected] of Object.entries(info.managedFiles ?? {})) {
        let managedPath;
        try {
          managedPath = assertAdapterManagedPath(repoRoot, skill, relPath);
        } catch (error) {
          errors.push(error.message);
          continue;
        }
        const actualHash = hashFile(managedPath);
        if (actualHash && actualHash !== expected) {
          warnings.push(
            `Managed companion drift: ${relPath} — will be overwritten from package`,
          );
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

    const contract = readContractTemplate(pkgRoot, name);
    if (contract?.foundation?.range && !satisfies(catalog.suiteVersion, contract.foundation.range)) {
      errors.push(
        `Skill "${name}" contract range ${contract.foundation.range} not satisfied by suite ${catalog.suiteVersion}`,
      );
      continue;
    }

    const foundationDir = pkgFoundationDir(pkgRoot, name);
    const foundationSkillMd = path.join(foundationDir, 'SKILL.md');
    const foundationText = fs.existsSync(foundationSkillMd)
      ? normalizeText(fs.readFileSync(foundationSkillMd, 'utf8'))
      : '';

    const companions = {};
    for (const rel of listFilesRel(foundationDir)) {
      if (rel === 'SKILL.md') continue;
      const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
      assertWithin(repoRoot, destRel);
      const text = normalizeText(fs.readFileSync(path.join(foundationDir, rel), 'utf8'));
      companions[destRel] = { text, hash: sha256(text) };
    }

    const adapterDest = repoAdapterDir(repoRoot, name);
    const skillMdPath = path.join(adapterDest, 'SKILL.md');
    const skillMdExists = fs.existsSync(skillMdPath);
    const existingText = skillMdExists ? fs.readFileSync(skillMdPath, 'utf8') : null;
    const fenceStatus = existingText ? inspectFences(existingText) : null;
    if (fenceStatus?.malformed) {
      errors.push(
        `Skill "${name}" has malformed APEX fence markers: ${fenceStatus.reason}. ` +
        `The file was left unchanged.`,
      );
      continue;
    }
    const existingFenced = existingText ? hasFence(existingText) : false;
    if (existingFenced && !splitZones(existingText).hasAdapterFence) {
      errors.push(
        `Skill "${name}" uses the legacy single-fence layout; APEX cannot safely separate ` +
        `its foundation from project adapter content. The file was left unchanged. ` +
        `Move any project rules below the managed fence or reinstall on a disposable branch.`,
      );
      continue;
    }

    const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
    const adapterSkillMd = boot.files['SKILL.md'] ?? '';
    const suiteVersion = catalog.suiteVersion;

    const adapterExtras = {};
    const adapterRuntimeFiles = listAdapterRuntimeFiles(skill);
    const missingAdapterFiles = [];
    for (const rel of adapterRuntimeFiles) {
      const text = boot.files[rel];
      if (typeof text !== 'string') {
        missingAdapterFiles.push(rel);
        continue;
      }
      const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
      assertWithin(repoRoot, destRel);
      const normalized = normalizeText(text);
      adapterExtras[destRel] = { text: normalized, hash: sha256(normalized) };
    }
    if (missingAdapterFiles.length) {
      errors.push(
        `Skill "${name}" is missing declared adapter runtime companion(s): ${missingAdapterFiles.join(', ')}`,
      );
      continue;
    }

    let skillMdAction = null;
    let skillMdText = null;
    let backupExisting = false;

    const foundationRegion = composeManaged(foundationText, '', name, suiteVersion);
    const adapterRegion = composeAdapter(adapterSkillMd, name, suiteVersion);

    if (!skillMdExists) {
      skillMdAction = 'create';
      skillMdText = compose(foundationText, adapterSkillMd, name, suiteVersion);
    } else if (existingFenced) {
      skillMdAction = 'splice';
      skillMdText = splice(existingText, foundationRegion);
      if (opts.fill) {
        const mergedAdapter = mergeAdapterRegions(
          existingText,
          adapterRegion,
          name,
          suiteVersion,
        );
        skillMdText = spliceAdapter(skillMdText, mergedAdapter);
      }
      const lockHash = existingLock?.skills?.[name]?.managedRegionHash;
      const actualHash = hashManaged(existingText);
      if (lockHash && actualHash && actualHash !== lockHash) {
        backupExisting = true;
      } else if (opts.fill && actualHash && actualHash !== hashManaged(skillMdText)) {
        backupExisting = true;
      }
    } else {
      skillMdAction = 'adopt';
      skillMdText = compose(
        foundationText,
        existingText,
        name,
        suiteVersion,
      );
      backupExisting = true;
      warnings.push(
        `Adapter for "${name}" existed without an APEX fence — adopted intact as project-owned content`,
      );
    }

    if (skillMdAction === 'splice' && opts.fill) {
      warnings.push(
        `Adapter for "${name}" foundation refreshed; unfilled project slots filled (--fill)`,
      );
    }

    actions.push({
      skill: name,
      companions: { ...companions, ...adapterExtras },
      skillMdAction,
      skillMdText,
      backupExisting,
      existingSkillMdText: backupExisting ? existingText : null,
      adapterScaffolded:
        skillMdAction === 'create' || skillMdAction === 'adopt',
      adapterFilled: skillMdAction === 'splice' && Boolean(opts.fill),
      contract,
    });
  }

  return { catalog, actions, errors, warnings };
}

/** Execute a previously computed plan. Writes files and the lockfile. */
export function executeInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const preflight = () => {
    assertLockfileIntegrity(repoRoot);
  };
  const perform = () => executeInstallUnlocked(pkgRoot, repoRoot, skillNames, opts);

  if (opts.dryRun) {
    preflight();
    return perform();
  }
  return withInstallTransaction(
    repoRoot,
    skillNames,
    perform,
    { preflight },
  );
}

function assertLockfileIntegrity(repoRoot) {
  const existingLock = readLockfile(repoRoot);
  const integrity = existingLock
    ? verifyLockfileIntegrity(existingLock)
    : { valid: true, error: null };
  if (!integrity.valid) {
    throw new Error(`Invalid apex-skills.lock.json: ${integrity.error}`);
  }
}

function executeInstallUnlocked(pkgRoot, repoRoot, skillNames, opts) {
  // Scope migration to ONLY the skills being installed (authorized set).
  const migration = migrateV1IfNeeded(pkgRoot, repoRoot, { ...opts, skillNames });
  if (migration.errors?.length) {
    const err = new Error('Migration aborted:\n  - ' + migration.errors.join('\n  - '));
    err.errors = migration.errors;
    throw err;
  }
  const { catalog, actions, errors, warnings } = planInstall(pkgRoot, repoRoot, skillNames, opts);
  const allWarnings = [...(migration.warnings ?? []), ...warnings];

  if (errors.length) {
    const err = new Error('Install aborted:\n  - ' + errors.join('\n  - '));
    err.errors = errors;
    throw err;
  }
  if (opts.dryRun) {
    return { dryRun: true, actions, warnings: allWarnings, wrote: [], migration };
  }

  const wrote = [...(migration.wrote ?? [])];
  const lock = readLockfile(repoRoot) ?? emptyLockfile(catalog.suiteVersion, catalog.package ?? '@apex/skills');
  lock.lockfileVersion = LOCKFILE_VERSION;
  lock.suiteVersion = catalog.suiteVersion;
  for (const name of Object.keys(lock.skills ?? {})) {
    if (lock.skills[name]?.vendored) {
      const { vendored, ...rest } = lock.skills[name];
      lock.skills[name] = rest;
    }
  }

  for (const action of actions) {
    const managedFiles = {};

    if (action.backupExisting && action.existingSkillMdText) {
      const backupRel = writeBackup(repoRoot, action.skill, 'SKILL.md', action.existingSkillMdText);
      wrote.push(backupRel);
      allWarnings.push(
        action.skillMdAction === 'adopt'
          ? `Backed up pre-adoption team skill to ${backupRel}`
          : `Backed up drifted foundation fence to ${backupRel}`,
      );
    }

    if (
      action.skillMdAction === 'create' ||
      action.skillMdAction === 'splice' ||
      action.skillMdAction === 'adopt'
    ) {
      const destRel = toPosix(path.join(ADAPTER_DIR, action.skill, 'SKILL.md'));
      assertWithin(repoRoot, destRel);
      writeTextFile(path.join(repoRoot, destRel), action.skillMdText);
      wrote.push(destRel);
    }

    for (const [destRel, { text, hash }] of Object.entries(action.companions)) {
      const destination = assertWithin(repoRoot, destRel);
      writeTextFile(destination, text);
      managedFiles[destRel] = hash;
      wrote.push(destRel);
    }

    const skillMdAbs = path.join(repoRoot, ADAPTER_DIR, action.skill, 'SKILL.md');
    const regionHash = fs.existsSync(skillMdAbs)
      ? hashManaged(fs.readFileSync(skillMdAbs, 'utf8'))
      : null;

    const prev = lock.skills[action.skill] ?? {};
    lock.skills[action.skill] = {
      contractRange: action.contract?.foundation?.range ?? null,
      managedRegionHash: regionHash,
      managedFiles,
      adapterScaffolded:
        action.adapterScaffolded
        || action.adapterFilled
        || Boolean(prev.adapterScaffolded)
        || action.skillMdAction === 'splice',
    };
  }

  if (migration.didMigrate) {
    const legacyRoot = assertWithin(repoRoot, LEGACY_VENDOR_DIR);
    if (fs.existsSync(legacyRoot)) {
      fs.rmSync(legacyRoot, { recursive: true, force: true });
      allWarnings.push(
        `Removed legacy ${LEGACY_VENDOR_DIR}/ after migration ` +
        `(only installed skills were migrated; leftover foundation folders discarded)`,
      );
    }
  }

  const lockText = serializeLockfile({ ...lock, generatedAt: new Date().toISOString() });
  ensureDir(repoRoot);
  fs.writeFileSync(assertWithin(repoRoot, 'apex-skills.lock.json'), lockText, 'utf8');
  wrote.push('apex-skills.lock.json');

  return { dryRun: false, actions, warnings: allWarnings, wrote, migration };
}

/**
 * Migrate a v1 install (.apex/foundation) to the three-zone layout.
 * Only migrates skills listed in opts.skillNames (the install/authorize set).
 * Other leftover .apex/foundation/<skill>/ folders are discarded when the
 * legacy root is removed after install — they are NOT written into .cursor/skills.
 */
export function migrateV1IfNeeded(pkgRoot, repoRoot, opts = {}) {
  const warnings = [];
  const wrote = [];
  const lock = readLockfile(repoRoot);
  const legacyRoot = path.join(repoRoot, LEGACY_VENDOR_DIR);
  const hasLegacy = fs.existsSync(legacyRoot);
  const needsMigrate = isV1Lockfile(lock) || hasLegacy;

  if (!needsMigrate) {
    return { didMigrate: false, warnings, wrote };
  }

  const requested = Array.isArray(opts.skillNames) && opts.skillNames.length
    ? opts.skillNames
    : null;

  if (opts.dryRun) {
    warnings.push(
      requested
        ? `Would migrate v1 .apex/foundation for ${requested.length} installed skill(s) only`
        : 'Would migrate v1 .apex/foundation layout to fenced .cursor/skills adapters',
    );
    return { didMigrate: true, warnings, wrote };
  }

  const catalog = loadCatalog(pkgRoot);

  // Prefer the install set; fall back to lockfile keys; never scan the full legacy dir
  // unless no install set and no lockfile skills are known.
  let skillNames;
  if (requested) {
    skillNames = requested;
  } else if (lock?.skills && Object.keys(lock.skills).length) {
    skillNames = Object.keys(lock.skills);
  } else {
    skillNames = [];
    warnings.push(
      `Legacy ${LEGACY_VENDOR_DIR}/ present but no install skill list — ` +
      `skipping skill migration (legacy dir will still be removed)`,
    );
  }

  const legacyDirs = hasLegacy
    ? fs.readdirSync(legacyRoot).filter((d) => fs.statSync(path.join(legacyRoot, d)).isDirectory())
    : [];
  const skipped = legacyDirs.filter((d) => !skillNames.includes(d));
  if (skipped.length) {
    warnings.push(
      `Skipping migration for ${skipped.length} leftover foundation folder(s) not in this install: ` +
      skipped.slice(0, 8).join(', ') + (skipped.length > 8 ? ', …' : ''),
    );
  }

  const malformedAdapters = skillNames.filter((name) => {
    const skillMdPath = path.join(repoAdapterDir(repoRoot, name), 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return false;
    return inspectFences(fs.readFileSync(skillMdPath, 'utf8')).malformed;
  });
  if (malformedAdapters.length) {
    return {
      didMigrate: false,
      warnings,
      wrote,
      errors: malformedAdapters.map(
        (name) =>
          `Skill "${name}" has malformed APEX fence markers; legacy foundation ` +
          `was retained and no migration was attempted`,
      ),
    };
  }

  const unsafeAdapters = skillNames.filter((name) => {
    const skillMdPath = path.join(repoAdapterDir(repoRoot, name), 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) return false;
    const existing = fs.readFileSync(skillMdPath, 'utf8');
    return !hasFence(existing) && lock?.skills?.[name]?.adapterScaffolded !== true;
  });
  if (unsafeAdapters.length) {
    return {
      didMigrate: false,
      warnings,
      wrote,
      errors: unsafeAdapters.map(
        (name) =>
          `Skill "${name}" has an unfenced adapter not recorded as APEX-scaffolded; ` +
          `legacy foundation was retained and no migration was attempted`,
      ),
    };
  }

  for (const name of skillNames) {
    const legacyDir = repoLegacyVendorDir(repoRoot, name);
    if (!fs.existsSync(legacyDir)) continue;

    const vendored = lock?.skills?.[name]?.vendored ?? {};
    for (const [relPath, expected] of Object.entries(vendored)) {
      const abs = assertLegacyManagedPath(repoRoot, name, relPath);
      const actual = hashFile(abs);
      if (actual && actual !== expected) {
        const base = path.basename(relPath);
        const backupRel = writeBackup(repoRoot, name, `legacy-${base}`, fs.readFileSync(abs, 'utf8'));
        wrote.push(backupRel);
        warnings.push(`Backed up drifted legacy foundation ${relPath} → ${backupRel}`);
      }
    }

    for (const rel of listFilesRel(legacyDir)) {
      if (rel === 'SKILL.md') continue;
      const src = path.join(legacyDir, rel);
      const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
      assertWithin(repoRoot, destRel);
      writeTextFile(path.join(repoRoot, destRel), fs.readFileSync(src, 'utf8'));
      wrote.push(destRel);
    }

    const skillMdPath = path.join(repoAdapterDir(repoRoot, name), 'SKILL.md');
    const legacySkillMd = path.join(legacyDir, 'SKILL.md');
    const foundationText = fs.existsSync(legacySkillMd)
      ? fs.readFileSync(legacySkillMd, 'utf8')
      : '';

    if (!fs.existsSync(skillMdPath)) {
      const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
      const composed = compose(foundationText, boot.files['SKILL.md'] ?? '', name, catalog.suiteVersion);
      writeTextFile(skillMdPath, composed);
      wrote.push(toPosix(path.join(ADAPTER_DIR, name, 'SKILL.md')));
      warnings.push(`Migrated "${name}": created three-zone skill from legacy foundation`);
    } else if (!hasFence(fs.readFileSync(skillMdPath, 'utf8'))) {
      const existingAdapter = fs.readFileSync(skillMdPath, 'utf8');
      const composed = compose(
        foundationText,
        existingAdapter,
        name,
        catalog.suiteVersion,
      );
      writeTextFile(skillMdPath, composed);
      wrote.push(toPosix(path.join(ADAPTER_DIR, name, 'SKILL.md')));
      warnings.push(
        `Migrated "${name}": combined legacy foundation with its recorded scaffolded adapter`,
      );
    } else {
      const existing = fs.readFileSync(skillMdPath, 'utf8');
      if (!splitZones(existing).hasAdapterFence) {
        warnings.push(
          `Migrated "${name}": legacy single-fence skill cannot safely separate foundation ` +
          `from project adapter content; left unchanged for manual migration`,
        );
        continue;
      }
      const foundationRegion = composeManaged(foundationText, '', name, catalog.suiteVersion);
      const next = splice(existing, foundationRegion);
      if (next) {
        writeTextFile(skillMdPath, next);
        wrote.push(toPosix(path.join(ADAPTER_DIR, name, 'SKILL.md')));
        warnings.push(`Migrated "${name}": refreshed foundation; project adapter left unchanged`);
      }
    }
  }

  warnings.push(
    `v1 → v2 migration prepared for ${skillNames.length} skill(s); ` +
    `${LEGACY_VENDOR_DIR}/ will be removed after install completes`,
  );

  return { didMigrate: true, warnings, wrote };
}

export function writeBackup(repoRoot, skill, basename, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${basename}.${stamp}`;
  const destRel = toPosix(path.join(BACKUP_DIR, skill, fileName));
  assertWithin(repoRoot, destRel);
  writeTextFile(path.join(repoRoot, destRel), text);
  return destRel;
}

/**
 * Bootstrap path: merge the adapter zone (+ create full file if missing).
 * Never rewrites the foundation fence or project notes.
 * Previously filled APEX:slot values win over incoming detector output.
 */
export function applyAdapterSkillMd(repoRoot, skill, newAdapterRegion, {
  foundationText = '',
  version = '0.0.0',
} = {}) {
  const destRel = toPosix(path.join(ADAPTER_DIR, skill, 'SKILL.md'));
  const abs = path.join(repoRoot, destRel);
  assertWithin(repoRoot, destRel);

  if (!fs.existsSync(abs)) {
    const full = compose(foundationText, extractAdapterBody(newAdapterRegion), skill, version);
    writeTextFile(abs, full);
    return { wrote: destRel, skipped: false, backedUp: null, warning: null };
  }

  const existing = fs.readFileSync(abs, 'utf8');
  if (!hasFence(existing)) {
    return {
      wrote: null,
      skipped: true,
      backedUp: null,
      warning: `Adapter for "${skill}" has no APEX managed fence — bootstrap left it untouched`,
    };
  }

  const mergedRegion = mergeAdapterRegions(existing, newAdapterRegion, skill, version);
  const next = spliceAdapter(existing, mergedRegion);
  if (!next) {
    return {
      wrote: null,
      skipped: true,
      backedUp: null,
      warning: `Adapter for "${skill}" adapter-zone splice failed — left untouched`,
    };
  }
  writeTextFile(abs, next);
  return { wrote: destRel, skipped: false, backedUp: null, warning: null };
}

/** @deprecated use applyAdapterSkillMd — kept for any stray callers */
export function applyManagedSkillMd(repoRoot, skill, newManagedText, opts = {}) {
  // If caller passed a full compose() output, write/splice foundation+adapter.
  const text = normalizeText(newManagedText ?? '');
  if (hasFence(text) && text.includes('APEX:BEGIN adapter')) {
    const abs = path.join(repoRoot, ADAPTER_DIR, skill, 'SKILL.md');
    if (!fs.existsSync(abs)) {
      writeTextFile(abs, text);
      return { wrote: toPosix(path.join(ADAPTER_DIR, skill, 'SKILL.md')), skipped: false, backedUp: null, warning: null };
    }
    const existing = fs.readFileSync(abs, 'utf8');
    if (!hasFence(existing)) {
      return {
        wrote: null, skipped: true, backedUp: null,
        warning: `Adapter for "${skill}" has no APEX managed fence — left untouched`,
      };
    }
    const z = splitZones(text);
    let next = spliceFoundation(existing, z.prefix + z.managed);
    if (z.adapter) {
      const mergedAdapter = mergeAdapterRegions(
        existing,
        z.adapter,
        skill,
        opts.version ?? '0.0.0',
      );
      next = spliceAdapter(next, mergedAdapter);
    }
    writeTextFile(abs, next);
    return { wrote: toPosix(path.join(ADAPTER_DIR, skill, 'SKILL.md')), skipped: false, backedUp: null, warning: null };
  }
  return applyAdapterSkillMd(repoRoot, skill, newManagedText, opts);
}

function extractAdapterBody(adapterRegion) {
  // If given a full adapter zone, strip markers for compose(); else treat as body.
  const t = normalizeText(adapterRegion ?? '');
  const begin = /<!--\s*APEX:BEGIN\s+adapter[^>]*-->/.exec(t);
  const end = /<!--\s*APEX:END\s+adapter\s*-->/.exec(t);
  if (begin && end) {
    let body = t.slice(begin.index + begin[0].length, end.index);
    // drop notice comments at top
    body = body.replace(/^<!--[\s\S]*?-->\n*/, '');
    return body.trim() + '\n';
  }
  return t;
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

function assertLegacyManagedPath(repoRoot, skill, relPath) {
  return assertManagedPath(repoRoot, skill, relPath, LEGACY_VENDOR_DIR, 'legacy foundation');
}

function assertAdapterManagedPath(repoRoot, skill, relPath) {
  return assertManagedPath(repoRoot, skill, relPath, ADAPTER_DIR, 'skill directory');
}

function assertManagedPath(repoRoot, skill, relPath, ownerRoot, label) {
  const absolute = assertWithin(repoRoot, relPath);
  const canonical = toPosix(path.relative(repoRoot, absolute));
  const expectedRoot = toPosix(path.join(ownerRoot, skill));
  if (canonical !== expectedRoot && !canonical.startsWith(`${expectedRoot}/`)) {
    throw new Error(
      `Managed path is outside the ${label} for "${skill}": ${relPath}`,
    );
  }
  return absolute;
}
