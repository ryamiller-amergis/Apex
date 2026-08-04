/** install command — delegates to lib/commands.mjs */
import { cmdInstall } from '../commands.mjs';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { findGitRoot } from '../util.mjs';

export async function install({ skills = null, all = false, dryRun = false, fill = false, enrich = false } = {}) {
  const repoRoot = findGitRoot();

  // Pre-flight: verify prerequisites (incl. @apex registry + feed) before writing.
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  console.log('[apex-skills] Running pre-flight health check...');
  const doctorResult = runDoctor({
    repoRoot,
    requireRegistry: true,
    requireFeed: true,
  });
  console.log(formatDoctor(doctorResult, { showNextSteps: false }));

  if (!doctorResult.ok) {
    console.error(
      '\n[apex-skills] Cannot install — hard prerequisites not met.\n' +
      'Fix the FAIL items above (especially apex-registry / feed), then re-run:\n' +
      '  npx @apex/skills doctor\n' +
      '  npx @apex/skills install <skill…>',
    );
    process.exit(1);
  }

  console.log('');
  const exitCode = cmdInstall(
    { _: skills ?? [], all, dryRun, enrich, fill, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);

  if (!dryRun) {
    const skillList = skills?.length ? skills.join(' ') : (all ? '--all' : '');
    console.log(`
[apex-skills] Install complete.

Next: teach the skills your repo by running:
  npx @apex/skills bootstrap${skillList ? ' ' + skillList : ''}

This scans your codebase and fills adapter templates with project-specific
context (ADO org, team names, repo structure, etc.) so skills work correctly
in Cursor when used against your project.`);
  }
}
