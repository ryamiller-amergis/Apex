/** doctor command — delegates to lib/doctor.mjs */
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { findGitRoot } from '../util.mjs';

/**
 * @param {object} [opts]
 * @param {boolean} [opts.requireRegistry=true]
 * @param {boolean} [opts.requireFeed=true]
 * @param {boolean} [opts.checkFeed] Deprecated — prefer requireFeed
 * @param {boolean} [opts.quiet] Unused (kept for installer.mjs call sites)
 * @param {boolean} [opts.strict] Unused (kept for installer.mjs call sites)
 */
export async function doctor({
  requireRegistry = true,
  requireFeed = true,
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
  console.log(formatDoctor(result));
  if (!result.ok) process.exit(1);
  return result;
}
