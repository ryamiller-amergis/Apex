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
import { hashFile } from './util.mjs';
import { loadCatalog } from './catalog.mjs';
import { readLockfile, isV1Lockfile } from './lockfile.mjs';
import { satisfies } from './semver.mjs';
import { hashManaged, hasFence } from './managedRegion.mjs';
import { ADAPTER_DIR } from './layout.mjs';

export function checkRepo(pkgRoot, repoRoot) {
  const catalog = loadCatalog(pkgRoot);
  const lock = readLockfile(repoRoot);
  if (!lock) {
    return { installed: false, available: catalog.suiteVersion, skills: [], updateAvailable: false };
  }

  const skills = [];
  let updateAvailable = false;
  const v1 = isV1Lockfile(lock);

  for (const [name, info] of Object.entries(lock.skills ?? {})) {
    const compatible = info.contractRange ? satisfies(catalog.suiteVersion, info.contractRange) : true;
    let drift = false;
    let managedRegionDrift = false;
    let companionDrift = false;
    let missingFence = false;

    if (v1) {
      // Legacy: compare vendored foundation hashes
      for (const [relPath, expected] of Object.entries(info.vendored ?? {})) {
        const actual = hashFile(path.join(repoRoot, relPath));
        if (actual && actual !== expected) drift = true;
      }
    } else {
      const skillMd = path.join(repoRoot, ADAPTER_DIR, name, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
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
        const actual = hashFile(path.join(repoRoot, relPath));
        if (actual && actual !== expected) {
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
      updateAvailable: skillUpdate,
    });
  }

  return {
    installed: true,
    installedSuite: lock.suiteVersion,
    available: catalog.suiteVersion,
    updateAvailable,
    lockfileVersion: lock.lockfileVersion ?? (v1 ? 1 : 2),
    skills,
  };
}
