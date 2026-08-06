/** doctor command — delegates to lib/doctor.mjs */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import {
  checkApexAuthorization,
  readPackageVersion,
} from '../apexAuthorize.mjs';
import { findGitRoot } from '../util.mjs';

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

/**
 * @param {object} [opts]
 * @param {boolean} [opts.requireRegistry=true]
 * @param {boolean} [opts.requireFeed=true]
 * @param {boolean} [opts.requireApex=true] Verify this repo's APEX entitlement
 * @param {boolean} [opts.skipApexCheck=false] Escape hatch for --skip-apex-check
 * @param {boolean} [opts.checkFeed] Deprecated — prefer requireFeed
 * @param {boolean} [opts.quiet] Unused (kept for installer.mjs call sites)
 * @param {boolean} [opts.strict] Unused (kept for installer.mjs call sites)
 */
export async function doctor({
  requireRegistry = true,
  requireFeed = true,
  requireApex = true,
  skipApexCheck = false,
  checkFeed,
  quiet: _quiet,
  strict: _strict,
} = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}\n`);
  const result = runDoctor({
    repoRoot,
    requireRegistry,
    // Prefer explicit requireFeed; fall back to legacy checkFeed when provided.
    requireFeed: checkFeed === undefined ? requireFeed : checkFeed,
  });

  // Entitlement needs a network call, so it lives outside the synchronous
  // runDoctor and is appended to its checks before formatting.
  if (requireApex) {
    await appendApexAuthorization(result, { repoRoot, skip: skipApexCheck });
  }

  console.log(formatDoctor(result));
  if (!result.ok) process.exit(1);
  return result;
}

/**
 * Run the APEX entitlement check and merge it into a doctor result in place,
 * recomputing `ok` / `hardFailures`. Shared by doctor, install, and update.
 */
export async function appendApexAuthorization(
  result,
  {
    repoRoot,
    skip = false,
    packageVersion = readPackageVersion(PACKAGE_ROOT),
  },
) {
  const check = await checkApexAuthorization({
    repoRoot,
    skip,
    packageVersion,
  });
  result.checks.push(check);
  result.authorization = check.authorization ?? null;
  result.hardFailures = result.checks.filter((c) => c.hard && !c.ok);
  result.ok = result.hardFailures.length === 0;
  return check;
}
