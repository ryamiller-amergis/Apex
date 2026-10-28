import { runCommand } from './run-command.mjs';

export const DOCKER_UNAVAILABLE =
  'Docker is not available. Start Docker and run this command again.';

export async function dockerAvailable(env = process.env) {
  const result = await runCommand('docker', ['info'], { env });
  return result.error === null && result.status === 0;
}
