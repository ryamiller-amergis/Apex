/** update command — re-runs install for selected skills to update foundations */
import { cmdInstall } from '../commands.mjs';
import { findGitRoot } from '../util.mjs';

export async function update({ skills = null } = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  // update = install with --fill=false (preserves adapters)
  const exitCode = cmdInstall(
    { _: skills ?? [], dryRun: false, enrich: false, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
