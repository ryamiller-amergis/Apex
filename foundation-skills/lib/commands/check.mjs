/** check command — delegates to lib/commands.mjs */
import { cmdCheck } from '../commands.mjs';

export async function check() {
  const exitCode = cmdCheck({}, (msg) => console.log(msg));
  if (exitCode !== 0) process.exit(exitCode);
}
