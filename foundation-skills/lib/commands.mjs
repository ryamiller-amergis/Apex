/** Command implementations shared by the CLI and the Cursor wrapper. */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { executeInstall, applyAdapterSkillMd } from './install.mjs';
import { checkRepo } from './check.mjs';
import { bootstrapSkill } from './bootstrap.mjs';
import { runDoctor, formatDoctor } from './doctor.mjs';
import { validatePackage } from './validatePackage.mjs';
import {
  loadCatalog, findSkill, listAdapterRuntimeFiles, resolveSkillDependencyClosure,
} from './catalog.mjs';
import { readLockfile, serializeLockfile, LOCKFILE_VERSION } from './lockfile.mjs';
import {
  writeTextFile, assertWithin, toPosix, normalizeText, sha256, listFilesRel,
} from './util.mjs';
import { pkgFoundationDir } from './layout.mjs';
import { composeAdapter, hashManaged } from './managedRegion.mjs';
import { ensureAlwaysInstallSkills } from './alwaysInstall.mjs';
import { findSkillRootCollisions, resolveRepoSkillRoot } from './skillRoot.mjs';

/** The package root is two levels up from lib/commands.mjs. */
export function defaultPackageRoot() {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

export function cmdDoctor(opts, log) {
  const skipFeed = opts.skipFeed === true || opts['skip-feed'] === true;
  const result = runDoctor({
    // Default: full health check. --feed remains supported; --skip-feed for local package maintainers.
    requireRegistry: opts.skipRegistry !== true,
    requireFeed: skipFeed ? false : true,
    checkFeed: opts.feed === true ? true : undefined,
  });
  log(formatDoctor(result));
  return result.ok ? 0 : 1;
}

export function cmdValidate(opts, log) {
  const pkgRoot = opts.package ? path.resolve(opts.package) : defaultPackageRoot();
  const result = validatePackage(pkgRoot);
  for (const w of result.warnings) log(`WARN  ${w}`);
  for (const e of result.errors) log(`ERROR ${e}`);
  log(result.ok ? `Package valid (${result.warnings.length} warnings).` : `Package INVALID (${result.errors.length} errors).`);
  return result.ok ? 0 : 1;
}

export function cmdInstall(opts, log) {
  const pkgRoot = opts.package ? path.resolve(opts.package) : defaultPackageRoot();
  const repoRoot = path.resolve(opts.cwd ?? process.cwd());

  // Require explicit skill names or --all. Bare install used to silently install
  // the full catalog; now it's an error so teams only get what their APEX release selected.
  if (!opts._.length && !opts.all) {
    log(
      '[apex-skills] ERROR: No skills specified.\n' +
      '\n' +
      'Use the install command from the APEX Getting started banner (it lists your project\'s\n' +
      'selected skills), or pass skill names explicitly:\n' +
      '\n' +
      '  npx @apex/skills install skill-a skill-b …\n' +
      '\n' +
      'To install every skill in the package (not recommended for first-time onboarding):\n' +
      '\n' +
      '  npx @apex/skills install --all',
    );
    return 1;
  }

  // Hard prerequisite gate — registry + feed must be healthy before install.
  const doc = runDoctor({
    repoRoot: path.resolve(opts.cwd ?? process.cwd()),
    requireRegistry: opts.skipFeed !== true,
    requireFeed: opts.skipFeed !== true,
  });
  if (!doc.ok) {
    log(formatDoctor(doc, { showNextSteps: false }));
    log('\nInstall refused: fix hard prerequisites above, then re-run doctor / install.');
    return 1;
  }

  try {
    const catalog = loadCatalog(pkgRoot);
    const skills = opts._.length
      ? ensureAlwaysInstallSkills(resolveSkillDependencyClosure(catalog, opts._))
      : allSkillNames(pkgRoot);
    const result = executeInstall(pkgRoot, repoRoot, skills, {
      dryRun: opts.dryRun,
      enrich: opts.enrich,
      fill: opts.fill,
      skillRoot: opts.skillRoot,
    });
    for (const w of result.warnings) log(`WARN  ${w}`);
    if (result.dryRun) {
      log(`[dry-run] would write ${countWrites(result.actions)} files for: ${skills.join(', ')}`);
    } else {
      log(`Installed ${skills.length} skill(s); wrote ${result.wrote.length} files.`);
    }
    return 0;
  } catch (e) {
    log(String(e.message ?? e));
    return 1;
  }
}

export function cmdCheck(opts, log) {
  const pkgRoot = opts.package ? path.resolve(opts.package) : defaultPackageRoot();
  const repoRoot = path.resolve(opts.cwd ?? process.cwd());
  const result = checkRepo(pkgRoot, repoRoot);
  if (!result.installed) {
    log(`No apex-skills.lock.json found. Available suite: ${result.available}.`);
    return 0;
  }
  log(`Installed suite ${result.installedSuite}; available ${result.available}.`);
  log(`Canonical skill root: ${result.skillRoot}.`);
  for (const s of result.skills) {
    const flags = [
      s.compatible ? 'compatible' : 'INCOMPATIBLE',
      s.rootCollision ? `ROOT-COLLISION(${s.collisionRoots.join(',')})` : null,
      s.missingFence ? 'MISSING-FENCE' : null,
      s.managedRegionDrift ? 'MANAGED-DRIFT' : null,
      s.companionDrift ? 'COMPANION-DRIFT' : null,
      s.drift && !s.missingFence && !s.managedRegionDrift && !s.companionDrift ? 'DRIFT' : null,
      s.updateAvailable ? 'update-available' : null,
    ].filter(Boolean).join(', ');
    log(`  - ${s.name}: ${flags}`);
  }
  const invalid =
    result.lockfileIntegrityValid === false ||
    result.skills.some((skill) => skill.drift || !skill.compatible);
  return invalid ? 1 : 0;
}

export function cmdBootstrap(opts, log) {
  const pkgRoot = opts.package ? path.resolve(opts.package) : defaultPackageRoot();
  const repoRoot = path.resolve(opts.cwd ?? process.cwd());
  const named = opts._ ?? [];

  // Default / --all: skills recorded in the lockfile only.
  // This prevents "installed 4 skills, bootstrap touched 31" after a scoped install.
  let skills;
  if (named.length) {
    skills = named;
  } else {
    const lock = readLockfile(repoRoot);
    if (!lock || !Object.keys(lock.skills ?? {}).length) {
      log(
        '[apex-skills] ERROR: No apex-skills.lock.json found (or no skills installed).\n' +
        'Run install first, or pass skill names explicitly:\n' +
        '\n' +
        '  npx @apex/skills bootstrap skill-a skill-b …\n' +
        '\n' +
        'To bootstrap every installed skill:\n' +
        '\n' +
        '  npx @apex/skills bootstrap --all',
      );
      return 1;
    }
    skills = Object.keys(lock.skills);
    if (opts.all) {
      log(`[apex-skills] bootstrap --all scopes to ${skills.length} installed skill(s) from the lockfile.`);
    }
  }

  if (Array.isArray(opts.authorizedSkills)) {
    const authorized = new Set(opts.authorizedSkills);
    const rejected = skills.filter((name) => !authorized.has(name));
    if (rejected.length) {
      log(
        `[apex-skills] ERROR: Cannot bootstrap skills not released for this package version:\n` +
        `  ${rejected.join(', ')}`,
      );
      return 1;
    }
  }

  const catalog = loadCatalog(pkgRoot);
  const lock = readLockfile(repoRoot);
  const skillRoot = resolveRepoSkillRoot(repoRoot, { lock });
  const collisions = findSkillRootCollisions(repoRoot, skills, skillRoot);
  if (collisions.length) {
    for (const collision of collisions) {
      log(
        `[apex-skills] ERROR: Skill "${collision.skill}" exists across ` +
        `${collision.roots.join(', ')}; canonical root is ${skillRoot}.`,
      );
    }
    return 1;
  }

  for (const name of skills) {
    const skillDef = findSkill(catalog, name);
    if (!skillDef) {
      log(`[apex-skills] ERROR: Unknown skill in catalog: ${name}`);
      return 1;
    }
    const boot = bootstrapSkill(pkgRoot, repoRoot, name, {
      enrich: opts.enrich,
      skillRoot,
    });
    const wrote = writeBootstrapFiles(
      pkgRoot,
      repoRoot,
      skillDef,
      boot.files,
      catalog.suiteVersion,
      skillRoot,
    );
    log(`Bootstrapped "${name}": ${boot.meta.filesScanned} files scanned, capHit=${boot.meta.capHit}, wrote ${wrote.length} file(s).`);
    for (const w of wrote.warnings ?? []) log(`WARN  ${w}`);
    if (opts.explain) {
      for (const [file, explain] of Object.entries(boot.explain)) {
        for (const [slot, info] of Object.entries(explain)) {
          const srcs = (info.evidence ?? []).map((e) => e.source?.file).filter(Boolean).slice(0, 3).join(', ');
          log(`    ${file} :: ${slot} -> ${info.filled ? `filled from [${srcs}]` : 'TODO'}`);
        }
      }
    }
  }

  // Refresh lockfile hashes for skills we touched.
  refreshLockfileHashes(pkgRoot, repoRoot, skills, skillRoot);

  return 0;
}

/**
 * Persist bootstrapped content:
 *   - SKILL.md adapter zone merged (filled APEX:slot values preserved;
 *     foundation fence + project notes untouched)
 *   - companion foundation files always overwritten
 *   - apex-skill.json written when produced by the template
 */
function writeBootstrapFiles(
  pkgRoot,
  repoRoot,
  skillDef,
  files,
  suiteVersion,
  skillRoot,
) {
  const wrote = [];
  const warnings = [];
  const skill = skillDef.name;

  const foundationDir = pkgFoundationDir(pkgRoot, skill);
  const foundationSkillMd = path.join(foundationDir, 'SKILL.md');
  const foundationText = fs.existsSync(foundationSkillMd)
    ? fs.readFileSync(foundationSkillMd, 'utf8')
    : '';

  const adapterRegion = composeAdapter(files['SKILL.md'] ?? '', skill, suiteVersion);
  const result = applyAdapterSkillMd(repoRoot, skill, adapterRegion, {
    foundationText,
    version: suiteVersion,
    skillRoot,
  });
  if (result.warning) warnings.push(result.warning);
  if (result.backedUp) wrote.push(result.backedUp);
  if (result.wrote) wrote.push(result.wrote);

  for (const rel of listFilesRel(foundationDir)) {
    if (rel === 'SKILL.md') continue;
    const destRel = toPosix(path.join(skillRoot, skill, rel));
    assertWithin(repoRoot, destRel);
    writeTextFile(path.join(repoRoot, destRel), fs.readFileSync(path.join(foundationDir, rel), 'utf8'));
    wrote.push(destRel);
  }

  for (const rel of listAdapterRuntimeFiles(skillDef)) {
    if (typeof files[rel] !== 'string') {
      throw new Error(`Skill "${skill}" is missing declared adapter runtime companion "${rel}" during bootstrap`);
    }
    const destRel = toPosix(path.join(skillRoot, skill, rel));
    assertWithin(repoRoot, destRel);
    writeTextFile(path.join(repoRoot, destRel), files[rel]);
    wrote.push(destRel);
  }

  wrote.warnings = warnings;
  return wrote;
}

function refreshLockfileHashes(pkgRoot, repoRoot, skills, skillRoot) {
  const lock = readLockfile(repoRoot);
  if (!lock) return;
  const catalog = loadCatalog(pkgRoot);
  lock.lockfileVersion = LOCKFILE_VERSION;
  lock.skillRoot = skillRoot;
  for (const name of skills) {
    if (!lock.skills[name]) continue;
    const skillDef = findSkill(catalog, name);
    if (!skillDef) continue;
    const skillMd = path.join(repoRoot, skillRoot, name, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      lock.skills[name].managedRegionHash = hashManaged(fs.readFileSync(skillMd, 'utf8'));
    }
    const managedFiles = {};
    const foundationDir = pkgFoundationDir(pkgRoot, name);
    for (const rel of listFilesRel(foundationDir)) {
      if (rel === 'SKILL.md') continue;
      const destRel = toPosix(path.join(skillRoot, name, rel));
      const abs = path.join(repoRoot, destRel);
      if (fs.existsSync(abs)) {
        managedFiles[destRel] = sha256(normalizeText(fs.readFileSync(abs, 'utf8')));
      }
    }
    for (const rel of listAdapterRuntimeFiles(skillDef)) {
      const destRel = toPosix(path.join(skillRoot, name, rel));
      const abs = path.join(repoRoot, destRel);
      if (fs.existsSync(abs)) {
        managedFiles[destRel] = sha256(normalizeText(fs.readFileSync(abs, 'utf8')));
      }
    }
    lock.skills[name].managedFiles = managedFiles;
    if (lock.skills[name].vendored) delete lock.skills[name].vendored;
  }
  fs.writeFileSync(
    path.join(repoRoot, 'apex-skills.lock.json'),
    serializeLockfile({ ...lock, generatedAt: new Date().toISOString() }),
    'utf8',
  );
}

function allSkillNames(pkgRoot) {
  try {
    return (loadCatalog(pkgRoot).skills ?? []).map((s) => s.name);
  } catch {
    return [];
  }
}

function countWrites(actions) {
  let n = 0;
  for (const a of actions) {
    n += Object.keys(a.companions ?? {}).length;
    if (
      a.skillMdAction === 'create' ||
      a.skillMdAction === 'splice' ||
      a.skillMdAction === 'adopt'
    ) n += 1;
  }
  return n + 1; // lockfile
}
