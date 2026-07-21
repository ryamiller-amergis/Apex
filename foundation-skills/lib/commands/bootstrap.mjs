/** bootstrap command — delegates to lib/commands.mjs */
import { cmdBootstrap } from '../commands.mjs';

export async function bootstrap({ skills = null, explain = false, enrich = false } = {}) {
  const exitCode = cmdBootstrap(
    { _: skills ?? [], explain, enrich },
    (msg) => console.log(msg),
  );
  if (exitCode !== 0) process.exit(exitCode);
}
