/** install command — delegates to lib/commands.mjs */
import { cmdInstall, defaultPackageRoot } from '../commands.mjs';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { appendApexAuthorization } from './doctor.mjs';
import {
  writeApexConfig,
  partitionRequestedSkills,
  readPackageVersion,
  verifyArtifactVersion,
  CONFIG_REL_PATH,
} from '../apexAuthorize.mjs';
import { findGitRoot } from '../util.mjs';

export async function install({
  skills = null,
  all = false,
  dryRun = false,
  fill = false,
  enrich = false,
  skipApexCheck = false,
} = {}) {
  const repoRoot = findGitRoot();

  // Pre-flight: verify prerequisites (incl. @apex registry + feed) before writing.
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  console.log('[apex-skills] Running pre-flight health check...');
  const doctorResult = runDoctor({
    repoRoot,
    requireRegistry: true,
    requireFeed: true,
  });
  await appendApexAuthorization(doctorResult, { repoRoot, skip: skipApexCheck });
  console.log(formatDoctor(doctorResult, { showNextSteps: false }));

  if (!doctorResult.ok) {
    console.error(
      '\n[apex-skills] Cannot install — hard prerequisites not met.\n' +
      'Fix the FAIL items above, then re-run:\n' +
      '  npx @apex/skills doctor\n' +
      '  npx @apex/skills install <skill…>',
    );
    process.exit(1);
  }

  // Narrow the request to what this project's release actually ships. Installing
  // a skill APEX did not target would put unmanaged files in the repo that no
  // release can later update or roll back.
  const auth = doctorResult.authorization;

  // The release names the exact @apex/skills version it shipped; installing any
  // other version would vendor content this project was never granted.
  const versionCheck = verifyArtifactVersion(auth, readPackageVersion(defaultPackageRoot()));
  if (versionCheck?.severity === 'error') {
    console.error('\n' + versionCheck.message);
    process.exit(1);
  } else if (versionCheck) {
    console.warn('\n' + versionCheck.message);
  }

  let effectiveSkills = skills;
  let effectiveAll = all;

  if (auth?.authorizedSkills?.length) {
    if (all) {
      // --all means "everything I'm entitled to", not "the whole catalog".
      effectiveSkills = [...auth.authorizedSkills];
      effectiveAll = false;
      console.log(
        `\n[apex-skills] --all resolved to this project's released skills: ` +
        `${effectiveSkills.join(', ')}`,
      );
    } else if (skills?.length) {
      const { allowed, rejected } = partitionRequestedSkills(skills, auth.authorizedSkills);
      if (rejected.length) {
        console.error(
          `\n[apex-skills] Cannot install — not released to "${auth.apexProject}":\n` +
          `  ${rejected.join(', ')}\n` +
          `\nRelease ${auth.releaseVersion} ships these skills to your project:\n` +
          `  ${auth.authorizedSkills.join(', ')}\n` +
          `\nAsk an APEX admin to add the missing skills to the release, or install\n` +
          'only the released ones.',
        );
        process.exit(1);
      }
      effectiveSkills = allowed;
    }
  }

  console.log('');
  const exitCode = cmdInstall(
    { _: effectiveSkills ?? [], all: effectiveAll, dryRun, enrich, fill, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);

  // Record the entitlement so update / CI runs work without reaching APEX again.
  if (!dryRun && auth) {
    const written = writeApexConfig(repoRoot, auth);
    console.log(`\n[apex-skills] Recorded authorization in ${CONFIG_REL_PATH}`);
    if (process.env.APEX_SKILLS_DEBUG) console.log(`  → ${written}`);
  }

  if (!dryRun) {
    const skillList = effectiveSkills?.length
      ? effectiveSkills.join(' ')
      : (effectiveAll ? '--all' : '');
    console.log(`
[apex-skills] Install complete.

Next: teach the skills your repo by running:
  npx @apex/skills bootstrap${skillList ? ' ' + skillList : ''}

This scans your codebase and fills adapter templates with project-specific
context (ADO org, team names, repo structure, etc.) so skills work correctly
in Cursor when used against your project.

Commit ${CONFIG_REL_PATH} along with the skill files — it records which APEX
release authorized this install.`);
  }
}
