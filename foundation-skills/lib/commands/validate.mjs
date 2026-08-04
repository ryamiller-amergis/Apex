/** validate command — delegates to lib/commands.mjs */
import { cmdValidate } from '../commands.mjs';

export async function validate() {
  const exitCode = cmdValidate({}, (msg) => console.log(msg));
  if (exitCode !== 0) process.exit(exitCode);
}
