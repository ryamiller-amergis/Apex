/** update command — re-runs install for selected skills to update foundations */
import { cmdInstall, defaultPackageRoot } from '../commands.mjs';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { appendApexAuthorization } from './doctor.mjs';
import {
  writeApexConfig,
  readPackageVersion,
  verifyArtifactVersion,
} from '../apexAuthorize.mjs';
import { ensureAlwaysInstallSkills } from '../alwaysInstall.mjs';
import { loadCatalog, resolveSkillDependencyClosure } from '../catalog.mjs';
import { findGitRoot } from '../util.mjs';

function rejectUnauthorizedExpandedSkills(expandedSkills, authorizedSkills) {
  const authorized = new Set(authorizedSkills ?? []);
  const rejected = expandedSkills.filter((name) => !authorized.has(name));
  if (rejected.length) {
    throw new Error(
      `\n[apex-skills] Cannot update — the requested scope expands to unreleased dependencies:\n` +
      `  ${rejected.join(', ')}`,
    );
  }
  return expandedSkills;
}

export function resolveUpdateSkills({
  catalog,
  skills = null,
  authorizedSkills = null,
} = {}) {
  let requestedSkills = skills?.length
    ? resolveSkillDependencyClosure(catalog, skills)
    : null;

  if (requestedSkills && authorizedSkills?.length) {
    requestedSkills = rejectUnauthorizedExpandedSkills(requestedSkills, authorizedSkills);
  }

  let updateSkills = requestedSkills
    ? ensureAlwaysInstallSkills(requestedSkills)
    : (authorizedSkills?.length ? ensureAlwaysInstallSkills([...authorizedSkills]) : []);

  if (authorizedSkills?.length) {
    updateSkills = rejectUnauthorizedExpandedSkills(updateSkills, authorizedSkills);
  }

  return updateSkills;
}

export async function update({ skills = null, skipApexCheck = false } = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}`);

  // Update pulls new foundation content, so it needs the same entitlement gate
  // as install — a deprecated or retargeted release must stop updates too.
  const doctorResult = runDoctor({ repoRoot, requireRegistry: true, requireFeed: true });
  await appendApexAuthorization(doctorResult, { repoRoot, skip: skipApexCheck });

  if (!doctorResult.ok) {
    console.log(formatDoctor(doctorResult, { showNextSteps: false }));
    console.error(
      '\n[apex-skills] Cannot update — hard prerequisites not met.\n' +
      'Fix the FAIL items above, then re-run:\n' +
      '  npx @apex/skills doctor',
    );
    process.exit(1);
  }

  const versionCheck = verifyArtifactVersion(
    doctorResult.authorization,
    readPackageVersion(defaultPackageRoot()),
  );
  if (versionCheck?.severity === 'error') {
    console.error('\n' + versionCheck.message);
    process.exit(1);
  } else if (versionCheck) {
    console.warn('\n' + versionCheck.message);
  }

  const authSkills = doctorResult.authorization?.authorizedSkills;
  const catalog = loadCatalog(defaultPackageRoot());
  let updateSkills;
  try {
    updateSkills = resolveUpdateSkills({
      catalog,
      skills,
      authorizedSkills: authSkills ?? null,
    });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  // update = install with --fill=false (preserves adapters)
  const exitCode = cmdInstall(
    { _: updateSkills, dryRun: false, enrich: false, cwd: repoRoot },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);

  // Refresh the recorded release version after a successful update.
  if (doctorResult.authorization) {
    writeApexConfig(repoRoot, doctorResult.authorization);
  }
}
