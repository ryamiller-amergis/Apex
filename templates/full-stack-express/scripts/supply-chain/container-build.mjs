import { finish, isDirect } from './cli.mjs';
import {
  EXIT_CANNOT_RUN,
  EXIT_CLEAN,
  imageTag,
  templateRoot,
} from './constants.mjs';
import { DOCKER_UNAVAILABLE, dockerAvailable } from './docker.mjs';
import { runCommand } from './run-command.mjs';

export async function runContainerBuild(options = {}) {
  const root = options.root ?? templateRoot;
  const env = options.env ?? process.env;
  const tag = options.tag ?? imageTag;
  if (!(await dockerAvailable(env))) {
    return { exitCode: EXIT_CANNOT_RUN, lines: [DOCKER_UNAVAILABLE] };
  }
  const build = await runCommand('docker', ['build', '-t', tag, '.'], {
    cwd: root,
    env,
    stdio: options.stdio,
  });
  if (build.error || build.status !== 0) {
    return { exitCode: 1, lines: ['container build failed'] };
  }
  const inspect = await runCommand(
    'docker',
    ['image', 'inspect', tag, '--format', '{{.Size}}'],
    { cwd: root, env }
  );
  const size = inspect.stdout.trim();
  return {
    exitCode: EXIT_CLEAN,
    lines: [`image ${tag}`, `image size bytes: ${size}`],
  };
}

if (isDirect(import.meta.url)) {
  finish(await runContainerBuild({ stdio: 'inherit' }));
}
