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

export interface StudioRuntimeApiLinkResult {
  linked: boolean;
  runtimeContainerName: string | null;
  diagnosticMessage?: string;
}

/**
 * Makes `studio-api` resolve to one runtime application. A runtime from an
 * earlier revision is detached first so the alias never names two containers.
 */
export async function linkStudioToRuntimeApi(input: {
  docker: DockerCommandRunner;
  studioNetworkName: string;
  runtimeContainerName: string;
  probeApiHealth?: () => Promise<boolean>;
  onApiUnreachable?: (diagnostic: {
    studioNetworkName: string;
    runtimeContainerName: string;
    reason: string;
  }) => Promise<void> | void;
}): Promise<StudioRuntimeApiLinkResult> {
  const attached = await attachedRuntimeApplications(
    input.docker,
    input.studioNetworkName
  );
  if (attached === null) {
    const reason = `Studio network ${input.studioNetworkName} was not found when linking runtime API ${input.runtimeContainerName}.`;
    await input.onApiUnreachable?.({
      studioNetworkName: input.studioNetworkName,
      runtimeContainerName: input.runtimeContainerName,
      reason,
    });
    return {
      linked: false,
      runtimeContainerName: null,
      diagnosticMessage: reason,
    };
  }
  for (const name of attached) {
    if (name !== input.runtimeContainerName) {
      await disconnect(input.docker, input.studioNetworkName, name);
    }
  }
  if (!attached.includes(input.runtimeContainerName)) {
    try {
      await input.docker.run([
        'network',
        'connect',
        '--alias',
        STUDIO_API_ALIAS,
        input.studioNetworkName,
        input.runtimeContainerName,
      ]);
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'Could not connect runtime API container to Studio network.';
      await input.onApiUnreachable?.({
        studioNetworkName: input.studioNetworkName,
        runtimeContainerName: input.runtimeContainerName,
        reason,
      });
      throw error;
    }
  }
  if (input.probeApiHealth) {
    const reachable = await input.probeApiHealth().catch(() => false);
    if (!reachable) {
      const reason =
        'The Studio preview could not reach /api on the runtime container.';
      await input.onApiUnreachable?.({
        studioNetworkName: input.studioNetworkName,
        runtimeContainerName: input.runtimeContainerName,
        reason,
      });
      return {
        linked: true,
        runtimeContainerName: input.runtimeContainerName,
        diagnosticMessage: reason,
      };
    }
  }
  return {
    linked: true,
    runtimeContainerName: input.runtimeContainerName,
  };
}
