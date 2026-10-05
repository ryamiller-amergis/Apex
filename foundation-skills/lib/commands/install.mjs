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
import { ensureAlwaysInstallSkills } from '../alwaysInstall.mjs';
import { loadCatalog, resolveSkillDependencyClosure } from '../catalog.mjs';
import { findGitRoot } from '../util.mjs';

function rejectUnauthorizedExpandedSkills(expandedSkills, authorizedSkills, noun = 'install') {
  const { allowed, rejected } = partitionRequestedSkills(expandedSkills, authorizedSkills);
  if (rejected.length) {
    throw new Error(
      `\n[apex-skills] Cannot ${noun} — the requested scope expands to unreleased dependencies:\n` +
      `  ${rejected.join(', ')}\n` +
      `\nRelease authorization only includes:\n` +
      `  ${authorizedSkills.join(', ')}`,
    );
  }
  return allowed;
}

export function resolveInstallSkills({
  catalog,
  skills = null,
  all = false,
  authorizedSkills = null,
} = {}) {
  let effectiveSkills = skills?.length
    ? resolveSkillDependencyClosure(catalog, skills)
    : skills;
  let effectiveAll = all;

  if (authorizedSkills?.length) {
    if (all) {
      effectiveSkills = [...authorizedSkills];
      effectiveAll = false;
    } else if (effectiveSkills?.length) {
      effectiveSkills = rejectUnauthorizedExpandedSkills(
        effectiveSkills,
        authorizedSkills,
        'install',
      );
    }
  }

  if (effectiveSkills?.length) {
    effectiveSkills = ensureAlwaysInstallSkills(effectiveSkills);
    if (authorizedSkills?.length) {
      effectiveSkills = rejectUnauthorizedExpandedSkills(
        effectiveSkills,
        authorizedSkills,
        'install',
      );
    }
  }

  return { skills: effectiveSkills, all: effectiveAll };
}

export async function install({
  skills = null,
  all = false,
  dryRun = false,
  fill = false,
  enrich = false,
  skipFeed = false,
  skipApexCheck = false,
  skillRoot = null,
} = {}) {
  const repoRoot = findGitRoot();

  // Pre-flight: verify prerequisites (incl. @apex registry + feed) before writing.
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  console.log('[apex-skills] Running pre-flight health check...');
  const doctorResult = runDoctor({
    repoRoot,
    requireRegistry: !skipFeed,
    requireFeed: !skipFeed,
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
  const catalog = loadCatalog(defaultPackageRoot());

  try {
    ({ skills: effectiveSkills, all: effectiveAll } = resolveInstallSkills({
      catalog,
      skills,
      all,
      authorizedSkills: auth?.authorizedSkills ?? null,
    }));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (auth?.authorizedSkills?.length && all) {
    console.log(
      `\n[apex-skills] --all resolved to this project's released skills: ` +
      `${effectiveSkills.join(', ')}`,
    );
  }

  console.log('');
  const exitCode = cmdInstall(
    {
      _: effectiveSkills ?? [],
      all: effectiveAll,
      dryRun,
      enrich,
      fill,
      skipFeed,
      skillRoot,
      cwd: repoRoot,
    },
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

Next:
  1. Teach the skills your repo:
       npx @apex/skills bootstrap${skillList ? ' ' + skillList : ''}
     This fills adapter templates from repo evidence (paths, glossary, stack).

  2. In Cursor, run the readiness interview:
       /post-skill-bootstrap
     It scans only lockfile-installed skills for unfilled markers, asks you
     about gaps, and replaces those markers with confirmed values inside
     APEX:slot anchors (re-run is a no-op when none remain).

Commit ${CONFIG_REL_PATH} along with the skill files — it records which APEX
release authorized this install.`);
  }
}
