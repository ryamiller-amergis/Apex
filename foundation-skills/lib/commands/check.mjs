/** check command — delegates to lib/commands.mjs */
import { cmdCheck } from '../commands.mjs';
import { findGitRoot } from '../util.mjs';

export async function check() {
  const repoRoot = findGitRoot();
  const exitCode = cmdCheck({ cwd: repoRoot }, (msg) => console.log(msg));
  if (exitCode !== 0) process.exit(exitCode);
}
