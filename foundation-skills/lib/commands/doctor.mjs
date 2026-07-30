/** doctor command — delegates to lib/doctor.mjs */
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { findGitRoot } from '../util.mjs';

export async function doctor({ checkFeed = false } = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}\n`);
  const result = runDoctor({ checkFeed, repoRoot });
  console.log(formatDoctor(result));
  if (!result.ok) process.exit(1);
}
