/** install command — delegates to lib/commands.mjs */
import { cmdInstall, defaultPackageRoot } from '../commands.mjs';

export async function install({ skills = null, dryRun = false, fill = false, enrich = false } = {}) {
  const exitCode = cmdInstall(
    { _: skills ?? [], dryRun, enrich, fill },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
