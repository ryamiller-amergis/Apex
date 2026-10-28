import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finish, isDirect } from './cli.mjs';
import { EXIT_CANNOT_RUN, templateRoot } from './constants.mjs';
import { DOCKER_UNAVAILABLE, dockerAvailable } from './docker.mjs';
import { runCommand } from './run-command.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runContainerTests(options = {}) {
  const env = options.env ?? process.env;
  if (!(await dockerAvailable(env))) {
    return { exitCode: EXIT_CANNOT_RUN, lines: [DOCKER_UNAVAILABLE] };
  }
  const vitest = path.join(
    templateRoot,
    'node_modules',
    'vitest',
    'vitest.mjs'
  );
  const result = await runCommand(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      path.join(here, 'vitest.config.mjs'),
      'container-image.test.mjs',
    ],
    { cwd: templateRoot, env, stdio: options.stdio ?? 'inherit' }
  );
  if (result.error) {
    return {
      exitCode: EXIT_CANNOT_RUN,
      lines: ['container tests could not run'],
    };
  }
  return { exitCode: result.status ?? 1, lines: [] };
}

if (isDirect(import.meta.url)) {
  finish(await runContainerTests());
}
