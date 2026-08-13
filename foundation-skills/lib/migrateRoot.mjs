import fs from 'node:fs';
import path from 'node:path';
import {
  readLockfile,
  isV1Lockfile,
  serializeLockfile,
  verifyLockfileIntegrity,
} from './lockfile.mjs';
import { assertWithin, hashFile, ensureDir, toPosix } from './util.mjs';
import { hashManaged, hasFence, splitZones } from './managedRegion.mjs';
import { withInstallTransaction } from './installTransaction.mjs';
import {
  KNOWN_SKILL_ROOTS,
  normalizeSkillRoot,
  resolveSkillRoot,
} from './skillRoot.mjs';

export function planSkillRootMigration(repoRoot, targetRoot) {
  const lock = readLockfile(repoRoot);
  const errors = [];
  const actions = [];

  if (!lock) {
    return {
      sourceRoot: null,
      targetRoot: normalizeSkillRoot(targetRoot),
      actions,
      errors: [
        'No apex-skills.lock.json found; install skills before migrating roots.',
      ],
    };
  }
  const integrity = verifyLockfileIntegrity(lock);
  if (!integrity.valid) {
    return {
      sourceRoot: null,
      targetRoot: normalizeSkillRoot(targetRoot),
      actions,
      errors: [`Invalid apex-skills.lock.json: ${integrity.error}`],
    };
  }
  if (isV1Lockfile(lock)) {
    return {
      sourceRoot: null,
      targetRoot: normalizeSkillRoot(targetRoot),
      actions,
      errors: [
        'Legacy v1 installations must be upgraded with install before migrating roots.',
      ],
    };
  }

  const sourceRoot = resolveSkillRoot({ lock });
  const normalizedTarget = normalizeSkillRoot(targetRoot);
  if (sourceRoot === normalizedTarget) {
    return {
      sourceRoot,
      targetRoot: normalizedTarget,
      actions,
      errors,
      unchanged: true,
    };
  }

  const competingRoots = [
    ...new Set([normalizedTarget, ...KNOWN_SKILL_ROOTS]),
  ].filter((root) => root !== sourceRoot);

  for (const [skill, info] of Object.entries(lock.skills ?? {})) {
    const sourceDir = path.join(repoRoot, sourceRoot, skill);
    if (!fs.existsSync(sourceDir)) {
      errors.push(`Installed skill "${skill}" is missing from ${sourceRoot}.`);
      continue;
    }
    const collisionRoots = competingRoots.filter((root) =>
      fs.existsSync(path.join(repoRoot, root, skill))
    );
    if (collisionRoots.length) {
      errors.push(
        `Skill "${skill}" already exists outside ${sourceRoot}: ` +
          `${collisionRoots.join(', ')}.`
      );
      continue;
    }

    const skillMdPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      errors.push(`Installed skill "${skill}" is missing SKILL.md.`);
      continue;
    }
    const skillText = fs.readFileSync(skillMdPath, 'utf8');
    if (!hasFence(skillText)) {
      errors.push(`Installed skill "${skill}" has no APEX managed fence.`);
      continue;
    }
    const managedRegionHash = hashManaged(skillText);
    if (
      info.managedRegionHash &&
      managedRegionHash !== info.managedRegionHash
    ) {
      errors.push(
        `Installed skill "${skill}" has managed foundation drift; ` +
          'run check/update before migrating.'
      );
      continue;
    }

    const managedFiles = {};
    let companionDrift = false;
    for (const [relPath, expectedHash] of Object.entries(
      info.managedFiles ?? {}
    )) {
      const sourcePrefix = `${sourceRoot}/${skill}/`;
      const normalizedRel = path.posix.normalize(toPosix(relPath));
      if (!normalizedRel.startsWith(sourcePrefix)) {
        errors.push(
          `Managed path for "${skill}" is outside ${sourcePrefix}: ${relPath}`
        );
        companionDrift = true;
        continue;
      }
      const actualHash = hashFile(assertWithin(repoRoot, normalizedRel));
      if (actualHash === null || actualHash !== expectedHash) {
        errors.push(
          `Managed companion drift for "${skill}": ${normalizedRel}; ` +
            'run check/update before migrating.'
        );
        companionDrift = true;
        continue;
      }
      const suffix = normalizedRel.slice(sourcePrefix.length);
      managedFiles[`${normalizedTarget}/${skill}/${suffix}`] = actualHash;
    }
    if (companionDrift) continue;

    actions.push({
      skill,
      sourceDir: `${sourceRoot}/${skill}`,
      targetDir: `${normalizedTarget}/${skill}`,
      managedRegionHash,
      managedFiles,
    });
  }

  return {
    sourceRoot,
    targetRoot: normalizedTarget,
    actions,
    errors,
    unchanged: false,
  };
}

export function migrateSkillRoot(
  repoRoot,
  targetRoot,
  { dryRun = false } = {}
) {
  const plan = planSkillRootMigration(repoRoot, targetRoot);
  if (plan.errors.length) {
    const error = new Error(
      `Skill-root migration aborted:\n  - ${plan.errors.join('\n  - ')}`
    );
    error.errors = plan.errors;
    throw error;
  }
  if (plan.unchanged || dryRun) {
    const staleRootReferences = plan.unchanged
      ? []
      : collectStaleRootReferences(repoRoot, plan.sourceRoot, [
          plan.sourceRoot,
        ]);
    return { ...plan, dryRun, wrote: [], staleRootReferences };
  }

  const skillNames = plan.actions.map((action) => action.skill);
  return withInstallTransaction(
    repoRoot,
    skillNames,
    () => executeMigration(repoRoot, plan),
    { skillRoots: [plan.sourceRoot, plan.targetRoot] }
  );
}

function executeMigration(repoRoot, plan) {
  const lock = readLockfile(repoRoot);
  ensureDir(path.join(repoRoot, plan.targetRoot));

  for (const action of plan.actions) {
    const source = path.join(repoRoot, action.sourceDir);
    const target = path.join(repoRoot, action.targetDir);
    const skillMdPath = path.join(source, 'SKILL.md');
    const skillText = fs.readFileSync(skillMdPath, 'utf8');
    const rewrittenSkillText = rewriteCanonicalRootReferences(
      skillText,
      plan.sourceRoot,
      plan.targetRoot
    );
    if (rewrittenSkillText !== skillText) {
      fs.writeFileSync(skillMdPath, rewrittenSkillText, 'utf8');
    }
    ensureDir(path.dirname(target));
    fs.renameSync(source, target);
    lock.skills[action.skill].managedRegionHash =
      hashManaged(rewrittenSkillText);
    lock.skills[action.skill].managedFiles = action.managedFiles;
  }

  const sourceDir = path.join(repoRoot, plan.sourceRoot);
  if (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length === 0) {
    fs.rmdirSync(sourceDir);
  }

  lock.skillRoot = plan.targetRoot;
  lock.generatedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(repoRoot, 'apex-skills.lock.json'),
    serializeLockfile(lock),
    'utf8'
  );

  const staleRootReferences = collectStaleRootReferences(
    repoRoot,
    plan.sourceRoot,
    [plan.targetRoot, plan.sourceRoot]
  );

  return {
    ...plan,
    dryRun: false,
    wrote: [
      ...plan.actions.map((action) => action.targetDir),
      'apex-skills.lock.json',
    ],
    staleRootReferences,
  };
}

function rewriteCanonicalRootReferences(text, sourceRoot, targetRoot) {
  const zones = splitZones(text);
  if (!zones.hasFence) return text;
  return (
    zones.prefix +
    zones.managed +
    zones.adapter.replaceAll(sourceRoot, targetRoot) +
    zones.project
  );
}

const TEXT_EXTS = new Set([
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.txt',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.tsx',
]);

function walkTextFiles(absDir, visit) {
  if (!fs.existsSync(absDir)) return;
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (entry.isDirectory()) walkTextFiles(abs, visit);
      continue;
    }
    if (
      entry.isFile() &&
      TEXT_EXTS.has(path.extname(entry.name).toLowerCase())
    ) {
      visit(abs);
    }
  }
}

/**
 * Project notes (below the managed fence) are left intact on purpose.
 * Report leftover mentions of the old root so operators can clean them up.
 */
function collectStaleRootReferences(repoRoot, sourceRoot, searchRoots) {
  const stale = [];
  for (const relRoot of [...new Set(searchRoots.filter(Boolean))]) {
    walkTextFiles(path.join(repoRoot, relRoot), (absFile) => {
      try {
        const text = fs.readFileSync(absFile, 'utf8');
        if (text.includes(sourceRoot)) {
          stale.push(toPosix(path.relative(repoRoot, absFile)));
        }
      } catch {
        /* unreadable — skip */
      }
    });
  }
  return [...new Set(stale)].sort();
}
