/**
 * `check` / `update` support: compare an installed repo lockfile against the
 * package's available suite version and report per-skill compatibility.
 */
import path from 'node:path';
import { hashFile } from './util.mjs';
import { loadCatalog } from './catalog.mjs';
import { readLockfile } from './lockfile.mjs';
import { satisfies } from './semver.mjs';

export function checkRepo(pkgRoot, repoRoot) {
  const catalog = loadCatalog(pkgRoot);
  const lock = readLockfile(repoRoot);
  if (!lock) {
    return { installed: false, available: catalog.suiteVersion, skills: [], updateAvailable: false };
  }

  const skills = [];
  let updateAvailable = false;
  for (const [name, info] of Object.entries(lock.skills ?? {})) {
    const compatible = info.contractRange ? satisfies(catalog.suiteVersion, info.contractRange) : true;
    let drift = false;
    for (const [relPath, expected] of Object.entries(info.vendored ?? {})) {
      const actual = hashFile(path.join(repoRoot, relPath));
      if (actual && actual !== expected) drift = true;
    }
    const skillUpdate = catalog.suiteVersion !== lock.suiteVersion && compatible;
    if (skillUpdate) updateAvailable = true;
    skills.push({ name, installedSuite: lock.suiteVersion, compatible, drift, updateAvailable: skillUpdate });
  }

  return {
    installed: true,
    installedSuite: lock.suiteVersion,
    available: catalog.suiteVersion,
    updateAvailable,
    skills,
  };
}
