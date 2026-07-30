/** bootstrap command — delegates to lib/commands.mjs */
import { cmdBootstrap } from '../commands.mjs';
import { findGitRoot } from '../util.mjs';

export async function bootstrap({ skills = null, explain = false, enrich = false } = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  const exitCode = cmdBootstrap(
    { _: skills ?? [], explain, enrich, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
