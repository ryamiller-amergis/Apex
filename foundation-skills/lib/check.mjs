/**
 * `check` / `update` support: compare an installed repo lockfile against the
 * package's available suite version and report per-skill compatibility.
 *
 * Drift meanings (v2):
 *   - managedRegionDrift: fenced SKILL.md region hash differs from lockfile
 *   - missingFence: SKILL.md exists but has no APEX END marker
 *   - companionDrift: a managed companion file hash differs
 */
import path from 'node:path';
import fs from 'node:fs';
import { assertWithin, hashFile, toPosix } from './util.mjs';
import { loadCatalog } from './catalog.mjs';
import { readLockfile, isV1Lockfile, verifyLockfileIntegrity } from './lockfile.mjs';
import { satisfies } from './semver.mjs';
import { hashManaged, hasFence } from './managedRegion.mjs';
import { findSkillRootCollisions, resolveSkillRoot } from './skillRoot.mjs';

export function checkRepo(pkgRoot, repoRoot) {
  const catalog = loadCatalog(pkgRoot);
  const lock = readLockfile(repoRoot);
  if (!lock) {
    return { installed: false, available: catalog.suiteVersion, skills: [], updateAvailable: false };
  }

  const skills = [];
  let updateAvailable = false;
  const v1 = isV1Lockfile(lock);
  const lockIntegrity = verifyLockfileIntegrity(lock);
  if (!lockIntegrity.valid) {
    return {
      installed: true,
      installedSuite: lock.suiteVersion,
      available: catalog.suiteVersion,
      updateAvailable: false,
      lockfileVersion: lock.lockfileVersion ?? (v1 ? 1 : 2),
      lockfileIntegrityValid: false,
      lockfileIntegrityError: lockIntegrity.error,
      skillRoot: lock.skillRoot ?? null,
      skills: Object.keys(lock.skills ?? {}).map((name) => ({
        name,
        installedSuite: lock.suiteVersion,
        compatible: false,
        drift: true,
        managedRegionDrift: false,
        companionDrift: false,
        missingFence: false,
        rootCollision: false,
        collisionRoots: [],
        updateAvailable: false,
      })),
    };
  }
  const skillRoot = resolveSkillRoot({ lock });

  const catalogNames = new Set((catalog.skills ?? []).map((skill) => skill.name));
  const collisions = new Map(
    findSkillRootCollisions(
      repoRoot,
      Object.keys(lock.skills ?? {}),
      skillRoot,
    ).map((collision) => [collision.skill, collision]),
  );

  for (const [name, info] of Object.entries(lock.skills ?? {})) {
    const compatible =
      catalogNames.has(name) &&
      (info.contractRange ? satisfies(catalog.suiteVersion, info.contractRange) : true);
    let drift = !catalogNames.has(name);
    let managedRegionDrift = false;
    let companionDrift = false;
    let missingFence = false;
    const collision = collisions.get(name);
    const rootCollision = Boolean(collision);
    if (rootCollision) drift = true;

    if (v1 && catalogNames.has(name)) {
      // Legacy: compare vendored foundation hashes
      for (const [relPath, expected] of Object.entries(info.vendored ?? {})) {
        try {
          const actual = hashFile(managedPath(repoRoot, name, relPath, '.apex/foundation'));
          if (actual === null || actual !== expected) drift = true;
        } catch {
          drift = true;
        }
      }
    } else if (catalogNames.has(name)) {
      const skillMd = path.join(repoRoot, skillRoot, name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) {
        missingFence = true;
        drift = true;
      } else {
        const text = fs.readFileSync(skillMd, 'utf8');
        if (!hasFence(text)) {
          missingFence = true;
          drift = true;
        } else if (info.managedRegionHash) {
          const actual = hashManaged(text);
          if (actual && actual !== info.managedRegionHash) {
            managedRegionDrift = true;
            drift = true;
          }
        }
      }
      for (const [relPath, expected] of Object.entries(info.managedFiles ?? {})) {
        let actual = null;
        try {
          actual = hashFile(managedPath(repoRoot, name, relPath, skillRoot));
        } catch {
          // Invalid managed path is drift and must never be read.
        }
        if (actual === null || actual !== expected) {
          companionDrift = true;
          drift = true;
        }
      }
    }

    const skillUpdate = catalog.suiteVersion !== lock.suiteVersion && compatible;
    if (skillUpdate) updateAvailable = true;
    skills.push({
      name,
      installedSuite: lock.suiteVersion,
      compatible,
      drift,
      managedRegionDrift,
      companionDrift,
      missingFence,
      rootCollision,
      collisionRoots: collision?.roots ?? [],
      updateAvailable: skillUpdate,
    });
  }

  return {
    installed: true,
    installedSuite: lock.suiteVersion,
    available: catalog.suiteVersion,
    updateAvailable,
    lockfileVersion: lock.lockfileVersion ?? (v1 ? 1 : 2),
    lockfileIntegrityValid: lockIntegrity.valid,
    lockfileIntegrityError: lockIntegrity.error,
    skillRoot,
    skills,
  };
}

function managedPath(repoRoot, skill, relPath, ownerRoot) {
  const absolute = assertWithin(repoRoot, relPath);
  const canonical = toPosix(path.relative(repoRoot, absolute));
  const expectedRoot = toPosix(path.join(ownerRoot, skill));
  if (canonical !== expectedRoot && !canonical.startsWith(`${expectedRoot}/`)) {
    throw new Error(`Managed path is outside ${expectedRoot}: ${relPath}`);
  }
  return absolute;
}
