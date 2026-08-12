import { findGitRoot } from '../util.mjs';
import { migrateSkillRoot } from '../migrateRoot.mjs';

export async function migrateRoot({ to, dryRun = false } = {}) {
  if (!to) {
    throw new Error(
      'migrate-root requires --to <repo-relative-root> ' +
        '(for example, --to .agents/skills)'
    );
  }
  const repoRoot = findGitRoot();
  const result = migrateSkillRoot(repoRoot, to, { dryRun });

  if (result.unchanged) {
    console.log(
      `[apex-skills] Canonical skill root is already ${result.targetRoot}.`
    );
    return;
  }
  if (result.dryRun) {
    console.log(
      `[apex-skills] Would migrate ${result.actions.length} skill(s) ` +
        `from ${result.sourceRoot} to ${result.targetRoot}.`
    );
    return;
  }
  console.log(
    `[apex-skills] Migrated ${result.actions.length} skill(s) ` +
      `from ${result.sourceRoot} to ${result.targetRoot}.`
  );
}
