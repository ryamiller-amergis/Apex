/** bootstrap command — delegates to lib/commands.mjs */
import { cmdBootstrap } from '../commands.mjs';
import { runDoctor, formatDoctor } from '../doctor.mjs';
import { appendApexAuthorization } from './doctor.mjs';
import { findGitRoot } from '../util.mjs';

export async function bootstrap({
  skills = null,
  all = false,
  explain = false,
  enrich = false,
  skipApexCheck = false,
} = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}`);
  const doctorResult = runDoctor({
    repoRoot,
    requireRegistry: true,
    requireFeed: true,
  });
  await appendApexAuthorization(doctorResult, {
    repoRoot,
    skip: skipApexCheck,
  });
  if (!doctorResult.ok) {
    console.log(formatDoctor(doctorResult, { showNextSteps: false }));
    console.error(
      '\n[apex-skills] Cannot bootstrap — feed or release authorization failed.',
    );
    process.exit(1);
  }

  const exitCode = cmdBootstrap(
    {
      _: skills ?? [],
      all,
      explain,
      enrich,
      cwd: repoRoot,
      authorizedSkills:
        doctorResult.authorization?.authorizedSkills ?? null,
    },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
