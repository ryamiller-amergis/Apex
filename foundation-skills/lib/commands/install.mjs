/** install command — delegates to lib/commands.mjs */
import { cmdInstall } from '../commands.mjs';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { findGitRoot } from '../util.mjs';

export async function install({ skills = null, dryRun = false, fill = false, enrich = false } = {}) {
  const repoRoot = findGitRoot();

  // Pre-flight: verify prerequisites before writing anything.
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  console.log('[apex-skills] Running pre-flight checks...');
  const doctorResult = runDoctor({ repoRoot });
  console.log(formatDoctor(doctorResult, { showNextSteps: false }));

  if (!doctorResult.ok) {
    console.error('\n[apex-skills] Cannot install — hard prerequisites not met. Fix the issues above and retry.');
    process.exit(1);
  }

  console.log('');
  const exitCode = cmdInstall(
    { _: skills ?? [], dryRun, enrich, fill, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);

  if (!dryRun) {
    console.log(`
[apex-skills] Install complete.

Next: teach the skills your repo by running:
  npx @apex/skills bootstrap

This scans your codebase and fills adapter templates with project-specific
context (ADO org, team names, repo structure, etc.) so skills work correctly
in Cursor when used against your project.`);
  }
}
