import {
  isDockerResourceMissing,
  type DockerCommandRunner,
} from './dockerPreviewRuntime';

/**
 * A Studio session runs only the web dev server. Its `/api` calls go to the
 * verified runtime's application container, which Apex joins to the Studio
 * network under this alias. Both sides are Docker-local; a cloud sandbox
 * provider must give the Studio session an equivalent API upstream.
 */
export const STUDIO_API_ALIAS = 'studio-api';
export const STUDIO_API_PORT = 3000;
export const STUDIO_API_PROXY_TARGET = `http://${STUDIO_API_ALIAS}:${STUDIO_API_PORT}`;

const RUNTIME_APPLICATION_PREFIX = 'apex-preview-app-';

async function attachedRuntimeApplications(
  docker: DockerCommandRunner,
  studioNetworkName: string
): Promise<string[] | null> {
  let stdout: string;
  try {
    ({ stdout } = await docker.run([
      'network',
      'inspect',
      '--format',
      '{{json .Containers}}',
      studioNetworkName,
    ]));
  } catch (error) {
    if (isDockerResourceMissing(error)) return null;
    throw error;
  }
  const text = stdout.trim();
  if (text === '' || text === 'null') return [];
  const containers = JSON.parse(text) as Record<string, { Name?: string }>;
  return Object.values(containers)
    .map((container) => container.Name ?? '')
    .filter((name) => name.startsWith(RUNTIME_APPLICATION_PREFIX));
}

async function disconnect(
  docker: DockerCommandRunner,
  studioNetworkName: string,
  containerName: string
): Promise<void> {
  try {
    await docker.run([
      'network',
      'disconnect',
      '--force',
      studioNetworkName,
      containerName,
    ]);
  } catch (error) {
    if (!isDockerResourceMissing(error)) throw error;
  }
}

/** Detaches every runtime application so the Studio network can be removed. */
export async function detachRuntimeApis(
  docker: DockerCommandRunner,
  studioNetworkName: string
): Promise<void> {
  const attached = await attachedRuntimeApplications(docker, studioNetworkName);
  for (const name of attached ?? []) {
    await disconnect(docker, studioNetworkName, name);
  }
}

/**
 * Makes `studio-api` resolve to one runtime application. A runtime from an
 * earlier revision is detached first so the alias never names two containers.
 */
export async function linkStudioToRuntimeApi(input: {
  docker: DockerCommandRunner;
  studioNetworkName: string;
  runtimeContainerName: string;
}): Promise<void> {
  const attached =
    (await attachedRuntimeApplications(
      input.docker,
      input.studioNetworkName
    )) ?? [];
  for (const name of attached) {
    if (name !== input.runtimeContainerName) {
      await disconnect(input.docker, input.studioNetworkName, name);
    }
  }
  if (attached.includes(input.runtimeContainerName)) return;
  await input.docker.run([
    'network',
    'connect',
    '--alias',
    STUDIO_API_ALIAS,
    input.studioNetworkName,
    input.runtimeContainerName,
  ]);
}
