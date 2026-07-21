/**
 * check — report which installed foundations have available updates.
 *
 * Reads the lockfile, compares the installed version with the latest published
 * @apex/skills version, and verifies foundation file hashes for drift.
 */

import { readLockfile, verifyLockfile } from '../lockfile.mjs';
import { loadCatalog } from '../catalog-loader.mjs';
import { semverGt } from '../semver.mjs';
import { execSync } from 'node:child_process';

export async function check({ repoRoot = process.cwd() } = {}) {
  const lock = readLockfile(repoRoot);
  if (!lock) {
    console.log('\nNo apex-skills.lock.json found. Run `npx @apex/skills install <skill...>` first.\n');
    return { ok: false, reason: 'no-lockfile' };
  }

  const installed = lock.foundation?.version ?? '0.0.0';
  console.log(`\nInstalled @apex/skills: v${installed}`);
  console.log(`Selected skills: ${(lock.selectedSkills ?? []).join(', ')}`);

  // Check remote version (soft failure)
  let latest = installed;
  try {
    const out = execSync('npm view @apex/skills version --silent', { stdio: 'pipe', timeout: 10_000 });
    latest = out.toString().trim();
  } catch {
    console.log('  (Could not reach registry — skipping remote version check)');
  }

  if (semverGt(latest, installed)) {
    console.log(`\n  UPDATE AVAILABLE: v${latest} (run \`npx @apex/skills update\` to install)\n`);
  } else {
    console.log(`\n  Up to date (v${installed} is the latest).\n`);
  }

  // Verify foundation file hashes
  const { ok: hashOk, drifted } = verifyLockfile(lock, repoRoot);
  if (!hashOk) {
    console.log(`  WARNING: ${drifted.length} foundation file(s) have been modified since install:`);
    for (const f of drifted) console.log(`    - ${f}`);
    console.log('  Foundation files should not be edited. Run `apex-skills update` to restore them or commit intentionally.\n');
  } else {
    console.log('  Foundation file integrity: OK\n');
  }

  return { ok: true, installed, latest, upToDate: !semverGt(latest, installed), hashOk, drifted };
}
