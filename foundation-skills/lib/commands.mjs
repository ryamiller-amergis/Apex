/** Command implementations shared by the CLI and the Cursor wrapper. */
import path from 'node:path';
import url from 'node:url';
import { executeInstall, planInstall } from './install.mjs';
import { checkRepo } from './check.mjs';
import { bootstrapSkill } from './bootstrap.mjs';
import { runDoctor, formatDoctor } from './doctor.mjs';
import { validatePackage } from './validatePackage.mjs';
import { loadCatalog } from './catalog.mjs';
import { readLockfile } from './lockfile.mjs';
import { writeTextFile, assertWithin, toPosix } from './util.mjs';
import { ADAPTER_DIR } from './layout.mjs';

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
    requireRegistry: true,
    requireFeed: true,
  });
  if (!doc.ok) {
    log(formatDoctor(doc, { showNextSteps: false }));
    log('\nInstall refused: fix hard prerequisites above, then re-run doctor / install.');
    return 1;
  }

  const skills = opts._.length ? opts._ : allSkillNames(pkgRoot);
  try {
    const result = executeInstall(pkgRoot, repoRoot, skills, {
      dryRun: opts.dryRun,
      enrich: opts.enrich,
      fill: opts.fill,
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
  for (const s of result.skills) {
    const flags = [s.compatible ? 'compatible' : 'INCOMPATIBLE', s.drift ? 'DRIFT' : null, s.updateAvailable ? 'update-available' : null]
      .filter(Boolean)
      .join(', ');
    log(`  - ${s.name}: ${flags}`);
  }
  return 0;
}

export function cmdBootstrap(opts, log) {
  const pkgRoot = opts.package ? path.resolve(opts.package) : defaultPackageRoot();
  const repoRoot = path.resolve(opts.cwd ?? process.cwd());

  // Default to skills recorded in the lockfile, not the full catalog.
  // This prevents "installed 4 skills, bootstrap touched 31" after a scoped install.
  let skills;
  if (opts._.length) {
    skills = opts._;
  } else if (opts.all) {
    skills = allSkillNames(pkgRoot);
  } else {
    const lock = readLockfile(repoRoot);
    if (!lock || !Object.keys(lock.skills ?? {}).length) {
      log(
        '[apex-skills] ERROR: No apex-skills.lock.json found (or no skills installed).\n' +
        'Run install first, or pass skill names explicitly:\n' +
        '\n' +
        '  npx @apex/skills bootstrap skill-a skill-b …\n' +
        '\n' +
        'To bootstrap every skill in the package:\n' +
        '\n' +
        '  npx @apex/skills bootstrap --all',
      );
      return 1;
    }
    skills = Object.keys(lock.skills);
  }
  for (const name of skills) {
    const boot = bootstrapSkill(pkgRoot, repoRoot, name, { enrich: opts.enrich });
    const wrote = writeBootstrapFiles(repoRoot, name, boot.files);
    log(`Bootstrapped "${name}": ${boot.meta.filesScanned} files scanned, capHit=${boot.meta.capHit}, wrote ${wrote.length} file(s).`);
    if (opts.explain) {
      for (const [file, explain] of Object.entries(boot.explain)) {
        for (const [slot, info] of Object.entries(explain)) {
          const srcs = (info.evidence ?? []).map((e) => e.source?.file).filter(Boolean).slice(0, 3).join(', ');
          log(`    ${file} :: ${slot} -> ${info.filled ? `filled from [${srcs}]` : 'TODO'}`);
        }
      }
    }
  }
  return 0;
}

/** Persist rendered adapter files from bootstrapSkill into the consumer repo. */
function writeBootstrapFiles(repoRoot, skill, files) {
  const wrote = [];
  for (const [rel, text] of Object.entries(files)) {
    const destRel = toPosix(path.join(ADAPTER_DIR, skill, rel));
    assertWithin(repoRoot, destRel);
    writeTextFile(path.join(repoRoot, destRel), text);
    wrote.push(destRel);
  }
  return wrote;
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
    n += Object.keys(a.vendored).length;
    if (a.adapterScaffolded || a.adapterFilled) n += Object.keys(a.adapterFiles).length;
  }
  return n + 1; // lockfile
}
