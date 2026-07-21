/**
 * update — update selected foundations to the latest published version.
 *
 * Never overwrites existing team adapters (.cursor/skills/).
 * Only replaces .apex/foundation/<skill>/ files.
 */

import { install as runInstall } from '../installer.mjs';
import { readLockfile } from '../lockfile.mjs';

export async function update({ skills = null, repoRoot = process.cwd() } = {}) {
  const lock = readLockfile(repoRoot);
  if (!lock && !skills) {
    console.log('\nNo lockfile found. Run install first.\n');
    process.exit(1);
  }

  // If no explicit skills given, update all that are currently installed
  const toUpdate = skills ?? lock?.selectedSkills ?? [];
  if (!toUpdate.length) {
    console.log('\nNo skills specified or installed — nothing to update.\n');
    return;
  }

  console.log(`\nUpdating foundations: ${toUpdate.join(', ')}\n`);

  // update = install with fill:false (preserves adapters), dryRun:false
  const result = await runInstall({
    skills: toUpdate,
    dryRun: false,
    fill: false,
    enrich: false,
    repoRoot,
    onProgress: (evt) => {
      if (evt.step === 'foundation') console.log(`  + ${evt.skillId}: foundation updated`);
      if (evt.step === 'adapter' && evt.status === 'skipped') {
        console.log(`  ~ ${evt.skillId}: adapter preserved (use --fill to re-bootstrap)`);
      }
    },
  });

  if (!result.ok) {
    for (const e of result.errors) console.error(`  ERROR: ${e}`);
    process.exit(1);
  }

  console.log('\nUpdate complete. Foundation lockfile refreshed. Adapter files unchanged.\n');
}
