/** update command — re-runs install for selected skills to update foundations */
import { cmdInstall } from '../commands.mjs';

export async function update({ skills = null } = {}) {
  // update = install with --fill=false (preserves adapters)
  const exitCode = cmdInstall(
    { _: skills ?? [], dryRun: false, enrich: false },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
