/**
 * Transactional, repo-local install (Option 3 layout).
 *
 * For each selected skill:
 *   - compose foundation + rendered adapter into a fenced SKILL.md under
 *     .cursor/skills/<skill>/ (managed region + project notes stub)
 *   - copy companion foundation files (non-SKILL.md) alongside, always replaced
 *   - if an unfenced SKILL.md already exists, leave it untouched and warn
 *   - if a fenced SKILL.md exists, splice the managed region (preserve project tail)
 *   - back up in-fence drift to .apex/backups/<skill>/ before overwriting
 *   - migrate v1 (.apex/foundation) installs to v2 on first run
 *   - record managedRegionHash + managedFiles hashes in apex-skills.lock.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  hashFile, writeTextFile, normalizeText, sha256, assertWithin, toPosix, ensureDir,
  listFilesRel,
} from './util.mjs';
import {
  pkgFoundationDir, repoAdapterDir, repoBackupDir, repoLegacyVendorDir,
  ADAPTER_DIR, LEGACY_VENDOR_DIR, BACKUP_DIR,
} from './layout.mjs';
import { loadCatalog, findSkill } from './catalog.mjs';
import { readLockfile, emptyLockfile, serializeLockfile, isV1Lockfile, LOCKFILE_VERSION } from './lockfile.mjs';
import { bootstrapSkill } from './bootstrap.mjs';
import { satisfies } from './semver.mjs';
import {
  compose, composeManaged, splice, hashManaged, hasFence, split,
} from './managedRegion.mjs';

/**
 * Plan an install without writing. Returns { actions, errors, warnings }.
 */
export function planInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const catalog = loadCatalog(pkgRoot);
  const errors = [];
  const warnings = [];
  const actions = [];

  const existingLock = readLockfile(repoRoot);

  // Soft check: in-fence drift becomes a backup warning at execute time, not an abort.
  if (existingLock && !isV1Lockfile(existingLock)) {
    for (const [skill, info] of Object.entries(existingLock.skills ?? {})) {
      if (!info?.managedRegionHash) continue;
      const skillMd = path.join(repoRoot, ADAPTER_DIR, skill, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const actual = hashManaged(fs.readFileSync(skillMd, 'utf8'));
      if (actual && actual !== info.managedRegionHash) {
        warnings.push(
          `Managed region drift for "${skill}" — will back up to ${BACKUP_DIR}/${skill}/ before updating`,
        );
      }
      for (const [relPath, expected] of Object.entries(info.managedFiles ?? {})) {
        const actualHash = hashFile(path.join(repoRoot, relPath));
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

    // Companion files from the package foundation (everything except SKILL.md).
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
    const existingFenced = existingText ? hasFence(existingText) : false;

    // Always bootstrap to get rendered adapter body (and optional apex-skill.json).
    const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
    const adapterSkillMd = boot.files['SKILL.md'] ?? '';
    const suiteVersion = catalog.suiteVersion;

    // Other adapter-template files (e.g. apex-skill.json) — written only on scaffold/fill.
    const adapterExtras = {};
    for (const [rel, text] of Object.entries(boot.files)) {
      if (rel === 'SKILL.md') continue;
      if (rel === 'apex-skill.json') {
        // Keep contract copy for tooling; treat as managed companion.
        const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
        assertWithin(repoRoot, destRel);
        adapterExtras[destRel] = { text: normalizeText(text), hash: sha256(normalizeText(text)) };
      }
    }

    let skillMdAction = null; // 'create' | 'splice' | 'skip'
    let skillMdText = null;
    let backupExisting = false;

    if (!skillMdExists) {
      skillMdAction = 'create';
      skillMdText = compose(foundationText, adapterSkillMd, name, suiteVersion);
    } else if (existingFenced) {
      skillMdAction = 'splice';
      const newManaged = composeManaged(foundationText, adapterSkillMd, name, suiteVersion);
      skillMdText = splice(existingText, newManaged);
      const lockHash = existingLock?.skills?.[name]?.managedRegionHash;
      const actualHash = hashManaged(existingText);
      if (lockHash && actualHash && actualHash !== lockHash) {
        backupExisting = true;
      } else if (opts.fill) {
        // --fill always rewrites managed region; back up if content differs from what we'll write
        if (actualHash && actualHash !== hashManaged(skillMdText)) {
          backupExisting = true;
        }
      }
    } else {
      // Unfenced pre-existing team file — never touch unless somehow forced.
      // Even --fill skips: hand-written MaxView skills stay intact.
      skillMdAction = 'skip';
      warnings.push(
        `Adapter for "${name}" already exists without an APEX managed fence — left untouched`,
      );
    }

    if (skillMdAction === 'splice' && opts.fill) {
      warnings.push(`Adapter for "${name}" managed region re-filled from template (--fill)`);
    }

    actions.push({
      skill: name,
      companions: { ...companions, ...adapterExtras },
      skillMdAction,
      skillMdText,
      backupExisting,
      existingSkillMdText: backupExisting ? existingText : null,
      adapterScaffolded: skillMdAction === 'create',
      adapterFilled: skillMdAction === 'splice' && Boolean(opts.fill),
      contract,
    });
  }

  return { catalog, actions, errors, warnings };
}

/** Execute a previously computed plan. Writes files and the lockfile. */
export function executeInstall(pkgRoot, repoRoot, skillNames, opts = {}) {
  const migration = migrateV1IfNeeded(pkgRoot, repoRoot, opts);
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
  // Drop any leftover v1 `vendored` fields as we rewrite skill entries.
  for (const name of Object.keys(lock.skills ?? {})) {
    if (lock.skills[name]?.vendored) {
      const { vendored, ...rest } = lock.skills[name];
      lock.skills[name] = rest;
    }
  }

  for (const action of actions) {
    const managedFiles = {};

    // Backup in-fence drift before overwrite.
    if (action.backupExisting && action.existingSkillMdText) {
      const backupRel = writeBackup(repoRoot, action.skill, 'SKILL.md', action.existingSkillMdText);
      wrote.push(backupRel);
      allWarnings.push(`Backed up drifted managed region to ${backupRel}`);
    }

    // Write / splice SKILL.md
    if (action.skillMdAction === 'create' || action.skillMdAction === 'splice') {
      const destRel = toPosix(path.join(ADAPTER_DIR, action.skill, 'SKILL.md'));
      assertWithin(repoRoot, destRel);
      writeTextFile(path.join(repoRoot, destRel), action.skillMdText);
      wrote.push(destRel);
    }

    // Companions always overwrite.
    for (const [destRel, { text, hash }] of Object.entries(action.companions)) {
      writeTextFile(path.join(repoRoot, destRel), text);
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

  // After a successful install that migrated, remove leftover .apex/foundation.
  if (migration.didMigrate) {
    const legacyRoot = path.join(repoRoot, LEGACY_VENDOR_DIR);
    if (fs.existsSync(legacyRoot)) {
      fs.rmSync(legacyRoot, { recursive: true, force: true });
      allWarnings.push(`Removed legacy ${LEGACY_VENDOR_DIR}/ after migration`);
    }
  }

  const lockText = serializeLockfile({ ...lock, generatedAt: new Date().toISOString() });
  ensureDir(repoRoot);
  fs.writeFileSync(path.join(repoRoot, 'apex-skills.lock.json'), lockText, 'utf8');
  wrote.push('apex-skills.lock.json');

  return { dryRun: false, actions, warnings: allWarnings, wrote, migration };
}

/**
 * Migrate a v1 install (.apex/foundation + unfenced/partial adapters) to v2.
 * Safe to call when no v1 lockfile / no legacy dir — returns a no-op result.
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

  if (opts.dryRun) {
    warnings.push('Would migrate v1 .apex/foundation layout to fenced .cursor/skills adapters');
    return { didMigrate: true, warnings, wrote };
  }

  const catalog = loadCatalog(pkgRoot);
  const skillNames = lock?.skills
    ? Object.keys(lock.skills)
    : (hasLegacy ? fs.readdirSync(legacyRoot).filter((d) =>
        fs.statSync(path.join(legacyRoot, d)).isDirectory()) : []);

  for (const name of skillNames) {
    const legacyDir = repoLegacyVendorDir(repoRoot, name);
    if (!fs.existsSync(legacyDir)) continue;

    // Backup any drifted legacy foundation files.
    const vendored = lock?.skills?.[name]?.vendored ?? {};
    for (const [relPath, expected] of Object.entries(vendored)) {
      const abs = path.join(repoRoot, relPath);
      const actual = hashFile(abs);
      if (actual && actual !== expected) {
        const base = path.basename(relPath);
        const backupRel = writeBackup(repoRoot, name, `legacy-${base}`, fs.readFileSync(abs, 'utf8'));
        wrote.push(backupRel);
        warnings.push(`Backed up drifted legacy foundation ${relPath} → ${backupRel}`);
      }
    }

    // Move companions (non-SKILL.md) into .cursor/skills/<skill>/
    for (const rel of listFilesRel(legacyDir)) {
      if (rel === 'SKILL.md') continue;
      const src = path.join(legacyDir, rel);
      const destRel = toPosix(path.join(ADAPTER_DIR, name, rel));
      assertWithin(repoRoot, destRel);
      const text = fs.readFileSync(src, 'utf8');
      writeTextFile(path.join(repoRoot, destRel), text);
      wrote.push(destRel);
    }

    // If adapter SKILL.md is missing or unfenced, seed a fence from legacy foundation.
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
      warnings.push(`Migrated "${name}": created fenced adapter from legacy foundation`);
    } else if (!hasFence(fs.readFileSync(skillMdPath, 'utf8'))) {
      // Preserve the entire existing team file as the project tail; put foundation in the fence.
      const existing = fs.readFileSync(skillMdPath, 'utf8');
      const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
      const managed = composeManaged(foundationText, boot.files['SKILL.md'] ?? '', name, catalog.suiteVersion);
      // Build: managed + existing content as project section
      const merged = normalizeText(managed + '\n## Project notes (migrated)\n\n' + normalizeText(existing));
      // Backup the unfenced original first
      const backupRel = writeBackup(repoRoot, name, 'SKILL.md.pre-migrate', existing);
      wrote.push(backupRel);
      writeTextFile(skillMdPath, merged);
      wrote.push(toPosix(path.join(ADAPTER_DIR, name, 'SKILL.md')));
      warnings.push(
        `Migrated "${name}": wrapped existing adapter with APEX fence; original backed up to ${backupRel}`,
      );
    } else {
      // Already fenced — just splice fresh managed content from legacy+bootstrap.
      const existing = fs.readFileSync(skillMdPath, 'utf8');
      const boot = bootstrapSkill(pkgRoot, repoRoot, name, opts);
      const managed = composeManaged(foundationText, boot.files['SKILL.md'] ?? '', name, catalog.suiteVersion);
      const next = splice(existing, managed);
      if (next) {
        writeTextFile(skillMdPath, next);
        wrote.push(toPosix(path.join(ADAPTER_DIR, name, 'SKILL.md')));
        warnings.push(`Migrated "${name}": refreshed fenced managed region from legacy foundation`);
      }
    }
  }

  warnings.push(
    `v1 → v2 migration prepared for ${skillNames.length} skill(s); ` +
    `${LEGACY_VENDOR_DIR}/ will be removed after install completes`,
  );

  return { didMigrate: true, warnings, wrote };
}

/**
 * Write a timestamped backup under .apex/backups/<skill>/.
 * @returns {string} POSIX-relative path of the backup
 */
export function writeBackup(repoRoot, skill, basename, text) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${basename}.${stamp}`;
  const destRel = toPosix(path.join(BACKUP_DIR, skill, fileName));
  assertWithin(repoRoot, destRel);
  writeTextFile(path.join(repoRoot, destRel), text);
  return destRel;
}

/**
 * Apply a composed managed region to an on-disk SKILL.md (used by bootstrap).
 * Returns { wrote, skipped, backedUp, warning }.
 */
export function applyManagedSkillMd(repoRoot, skill, newManagedText, { expectedHash = null } = {}) {
  const destRel = toPosix(path.join(ADAPTER_DIR, skill, 'SKILL.md'));
  const abs = path.join(repoRoot, destRel);
  assertWithin(repoRoot, destRel);

  if (!fs.existsSync(abs)) {
    // No existing file — write composed managed + project stub
    const full = normalizeText(newManagedText);
    // If caller passed only managed region, append project stub
    const text = hasFence(full) && split(full).project === ''
      ? normalizeText(full + '\n## Project notes\n\n<!-- Yours. APEX never writes below this line. -->\n')
      : full;
    writeTextFile(abs, text);
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

  let backedUp = null;
  if (expectedHash) {
    const actual = hashManaged(existing);
    if (actual && actual !== expectedHash) {
      backedUp = writeBackup(repoRoot, skill, 'SKILL.md', existing);
    }
  } else {
    // No expected hash — still back up if splice will change managed content
    const next = splice(existing, newManagedText);
    if (next && hashManaged(existing) !== hashManaged(next)) {
      backedUp = writeBackup(repoRoot, skill, 'SKILL.md', existing);
    }
  }

  const next = splice(existing, newManagedText);
  if (!next) {
    return {
      wrote: null,
      skipped: true,
      backedUp: null,
      warning: `Adapter for "${skill}" splice failed — left untouched`,
    };
  }
  writeTextFile(abs, next);
  return {
    wrote: destRel,
    skipped: false,
    backedUp,
    warning: backedUp ? `Backed up in-fence edits to ${backedUp}` : null,
  };
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
