/**
 * Transactional skill installer
 *
 * Installs selected foundation skills into a target repo:
 *   1. Validates prerequisites (via doctor)
 *   2. Validates requested skill ids against catalog
 *   3. Stages foundation files into a temp directory
 *   4. Validates paths, contracts, and hashes
 *   5. Atomically replaces .apex/foundation/<skill>/ (only the selected skills)
 *   6. Bootstraps absent adapters via the bootstrapper
 *   7. Writes the lockfile
 *
 * Never overwrites existing adapter files (.cursor/skills/<skill>/SKILL.md).
 * Aborts on: name collisions, modified managed files, unsupported contract
 * ranges, path traversal, or incomplete artifact sets.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, basename, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { doctor }          from './commands/doctor.mjs';
import { loadCatalog, getSkillEntry } from './catalog-loader.mjs';
import { bootstrapSkill }  from './bootstrapper.mjs';
import { buildLockfile, writeLockfile, verifyLockfile, readLockfile, sha256, fileHash } from './lockfile.mjs';
import { FOUNDATION_DIR, FOUNDATION_DEST, ADAPTER_DEST, LOCK_FILENAME, repoPath, toPosix, relPosix } from './paths.mjs';

/**
 * Install selected foundation skills.
 *
 * @param {object}   opts
 * @param {string[]|null} opts.skills     skill ids to install; null = all in catalog
 * @param {boolean}  opts.dryRun
 * @param {boolean}  opts.fill            re-run bootstrap even if adapter exists
 * @param {boolean}  opts.enrich
 * @param {string}   [opts.repoRoot]      defaults to process.cwd()
 * @param {Function} [opts.onProgress]
 * @returns {{ ok: boolean, installed: string[], bootstrapped: string[], errors: string[] }}
 */
export async function install({
  skills = null,
  dryRun = false,
  fill   = false,
  enrich = false,
  repoRoot = process.cwd(),
  onProgress,
} = {}) {
  const errors    = [];
  const installed = [];
  const bootstrapped = [];

  // ── 1. Prerequisites ──────────────────────────────────────────────────────
  const { ok: prereqOk } = await doctor({
    quiet: !onProgress,
    strict: true,
    requireRegistry: true,
    requireFeed: true,
  });
  if (!prereqOk) {
    errors.push(
      'Prerequisite checks failed (registry/feed). Run `npx @apex/skills doctor` and fix FAIL items.',
    );
    return { ok: false, installed, bootstrapped, errors };
  }

  // ── 2. Resolve skill list ─────────────────────────────────────────────────
  const catalog    = loadCatalog();
  const allSkills  = catalog.skills.map(s => s.id);
  const skillList  = skills ?? allSkills;

  for (const id of skillList) {
    if (!allSkills.includes(id)) {
      errors.push(`Unknown skill id: "${id}". Available: ${allSkills.join(', ')}`);
    }
  }
  if (errors.length) return { ok: false, installed, bootstrapped, errors };

  // ── 3. Check lockfile for foundation drift ────────────────────────────────
  const existingLock = readLockfile(repoRoot);
  if (existingLock) {
    const { ok, drifted } = verifyLockfile(existingLock, repoRoot);
    if (!ok) {
      errors.push(
        `Foundation files have been modified since last install: ${drifted.join(', ')}. ` +
        `Reset them or run \`apex-skills update\` to accept the changes.`
      );
      return { ok: false, installed, bootstrapped, errors };
    }
  }

  // ── 4. Stage foundations into a temp directory ────────────────────────────
  const tmpBase  = join(tmpdir(), `apex-skills-${randomBytes(4).toString('hex')}`);
  const stagedFiles = [];

  try {
    for (const skillId of skillList) {
      const src  = join(FOUNDATION_DIR, skillId);
      const dest = join(tmpBase, skillId);
      if (!existsSync(src)) {
        errors.push(`Foundation not found for skill: ${skillId}`);
        continue;
      }
      cpSync(src, dest, { recursive: true });

      // Collect staged files (excluding bootstrap-recipe.json and adapter-template.md
      // which are installer-only assets, not vendored into the target repo)
      for (const f of walkDir(dest)) {
        const name = basename(f);
        if (name === 'bootstrap-recipe.json' || name === 'adapter-template.md') continue;
        stagedFiles.push({ skillId, srcAbs: f, destRel: toPosix(relative(tmpBase, f)) });
      }
    }

    if (errors.length) {
      rmSync(tmpBase, { recursive: true, force: true });
      return { ok: false, installed, bootstrapped, errors };
    }

    // ── 5. Path traversal guard ───────────────────────────────────────────
    for (const { destRel } of stagedFiles) {
      if (destRel.includes('..')) {
        errors.push(`Path traversal detected in staged file: ${destRel}`);
      }
    }
    if (errors.length) {
      rmSync(tmpBase, { recursive: true, force: true });
      return { ok: false, installed, bootstrapped, errors };
    }

    // ── 6. Write foundations (atomic per skill) ───────────────────────────
    const allAbsPaths = [];
    for (const skillId of skillList) {
      const destDir = repoPath(FOUNDATION_DEST, skillId);
      if (!dryRun) {
        mkdirSync(destDir, { recursive: true });
        cpSync(join(tmpBase, skillId), destDir, { recursive: true });
        // Remove installer-only assets from destination
        for (const name of ['bootstrap-recipe.json', 'adapter-template.md']) {
          const fp = join(destDir, name);
          if (existsSync(fp)) rmSync(fp);
        }
      }
      // Collect for lockfile
      for (const f of walkDir(join(tmpBase, skillId))) {
        if (['bootstrap-recipe.json', 'adapter-template.md'].includes(basename(f))) continue;
        const rel = toPosix(relative(tmpBase, f));
        allAbsPaths.push(join(repoRoot, FOUNDATION_DEST, rel));
      }
      installed.push(skillId);
      onProgress?.({ step: 'foundation', skillId, status: 'installed' });
    }

    // ── 7. Bootstrap absent adapters ─────────────────────────────────────
    for (const skillId of skillList) {
      const adapterPath = repoPath(ADAPTER_DEST, skillId, 'SKILL.md');
      const adapterExists = existsSync(adapterPath);
      if (adapterExists && !fill) {
        onProgress?.({ step: 'adapter', skillId, status: 'skipped' });
        continue;
      }
      onProgress?.({ step: 'adapter', skillId, status: 'bootstrap-start' });
      const result = await bootstrapSkill({ skillId, repoRoot, dryRun, enrich });
      bootstrapped.push(skillId);
      onProgress?.({ step: 'adapter', skillId, status: 'bootstrapped', todoCount: result.todoCount });
    }

    // ── 8. Write lockfile ─────────────────────────────────────────────────
    if (!dryRun) {
      const pkgJson = JSON.parse(readFileSync(join(FOUNDATION_DIR, '..', 'package.json'), 'utf-8'));
      const catalogHash = sha256(readFileSync(join(FOUNDATION_DIR, '..', 'catalog.json')));
      const lock = buildLockfile({
        version: pkgJson.version,
        skills:  skillList,
        absPaths: allAbsPaths.filter(p => existsSync(p)),
        repoRoot,
        catalogHash,
      });
      writeLockfile(lock, repoRoot);
    }

  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  if (!dryRun) {
    console.log(`\nInstalled ${installed.length} foundation(s), bootstrapped ${bootstrapped.length} adapter(s).`);
    console.log('Adapter files are yours to edit. Foundations are managed — do not edit .apex/foundation/.\n');
  } else {
    console.log(`\n[dry-run] Would install ${installed.length} foundation(s) and bootstrap ${bootstrapped.length} adapter(s).\n`);
  }

  return { ok: true, installed, bootstrapped, errors };
}

function* walkDir(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkDir(full);
    else yield full;
  }
}
