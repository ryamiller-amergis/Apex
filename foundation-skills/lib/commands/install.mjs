/** install command — delegates to the transactional installer */
import { install as runInstall } from '../installer.mjs';

export async function install({ skills, dryRun, fill, enrich } = {}) {
  function onProgress(evt) {
    if (evt.step === 'foundation') {
      console.log(`  + foundation: ${evt.skillId} ${evt.status}`);
    } else if (evt.step === 'adapter') {
      if (evt.status === 'skipped')    console.log(`  ~ adapter:    ${evt.skillId} (exists, use --fill to re-fill)`);
      if (evt.status === 'bootstrapped') {
        const todos = evt.todoCount > 0 ? ` — ${evt.todoCount} TODO placeholder(s)` : '';
        console.log(`  + adapter:    ${evt.skillId}${todos}`);
      }
    }
  }

  const result = await runInstall({ skills, dryRun, fill, enrich, onProgress });
  if (!result.ok) {
    for (const e of result.errors) console.error(`  ERROR: ${e}`);
    process.exit(1);
  }
}
