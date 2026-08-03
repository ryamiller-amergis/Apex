/** init-registry — create/merge local .npmrc with @apex:registry from template */
import { findGitRoot } from '../util.mjs';
import { initRegistry } from '../initRegistry.mjs';

export async function initRegistryCommand({
  org,
  feed,
  project,
  dryRun = false,
} = {}) {
  const repoRoot = findGitRoot();
  console.log(`[apex-skills] Repo root: ${repoRoot}\n`);

  const result = initRegistry(repoRoot, { org, feed, project, dryRun });

  const label = {
    'created-from-template': `Created ${result.npmrcPath} from .npmrc.template`,
    'created-minimal': `Created ${result.npmrcPath} (no .npmrc.template found)`,
    merged: `Updated ${result.npmrcPath} with @apex:registry`,
    unchanged: `.npmrc already has @apex:registry → ${result.registry}`,
  }[result.action];

  console.log(`[apex-skills] ${dryRun ? '[dry-run] ' : ''}${label}`);
  console.log(`[apex-skills] Registry: ${result.registry}`);
  if (result.templatePath) {
    console.log(`[apex-skills] Template: ${result.templatePath}`);
  }

  if (dryRun) {
    console.log('\n--- .npmrc preview ---\n');
    console.log(result.contentPreview);
  }

  console.log('');
  for (const step of result.nextSteps) console.log(step);
}
