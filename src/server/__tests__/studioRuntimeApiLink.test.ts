import type { DockerCommandRunner } from '../services/build/dockerPreviewRuntime';
import {
  STUDIO_API_ALIAS,
  detachRuntimeApis,
  linkStudioToRuntimeApi,
} from '../services/build/studioRuntimeApiLink';

class FakeDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly attached: Record<string, string> = {},
    private readonly missingNetwork = false
  ) {}

  async run(
    args: readonly string[]
  ): Promise<{ stdout: string; stderr: string }> {
    this.calls.push([...args]);
    if (args[0] === 'network' && args[1] === 'inspect') {
      if (this.missingNetwork) {
        throw Object.assign(new Error('network not found'), {
          stderr: 'Error: No such network',
        });
      }
      const containers = Object.fromEntries(
        Object.entries(this.attached).map(([id, name]) => [id, { Name: name }])
      );
      return { stdout: `${JSON.stringify(containers)}\n`, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
}

describe('Studio runtime API link', () => {
  it('connects the verified runtime application to the Studio network under the API alias', async () => {
    const docker = new FakeDocker({ a1: 'apex-studio-app-1' });

    await linkStudioToRuntimeApi({
      docker,
      studioNetworkName: 'apex-studio-network-1',
      runtimeContainerName: 'apex-preview-app-new',
    });

    expect(docker.calls).toContainEqual([
      'network',
      'connect',
      '--alias',
      STUDIO_API_ALIAS,
      'apex-studio-network-1',
      'apex-preview-app-new',
    ]);
  });

  it('disconnects an earlier revision runtime so the alias names one application', async () => {
    const docker = new FakeDocker({
      a1: 'apex-studio-app-1',
      a2: 'apex-preview-app-old',
    });

    await linkStudioToRuntimeApi({
      docker,
      studioNetworkName: 'apex-studio-network-1',
      runtimeContainerName: 'apex-preview-app-new',
    });

    const disconnect = docker.calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'disconnect'
    );
    const connect = docker.calls.findIndex(
      (args) => args[0] === 'network' && args[1] === 'connect'
    );
    expect(docker.calls[disconnect]).toEqual([
      'network',
      'disconnect',
      '--force',
      'apex-studio-network-1',
      'apex-preview-app-old',
    ]);
    expect(disconnect).toBeLessThan(connect);
  });

  it('does not reconnect a runtime that is already linked', async () => {
    const docker = new FakeDocker({ a2: 'apex-preview-app-new' });

    await linkStudioToRuntimeApi({
      docker,
      studioNetworkName: 'apex-studio-network-1',
      runtimeContainerName: 'apex-preview-app-new',
    });

    expect(
      docker.calls.some(
        (args) => args[0] === 'network' && args[1] === 'connect'
      )
    ).toBe(false);
  });

  it('detaches every runtime application before a Studio network is removed', async () => {
    const docker = new FakeDocker({
      a1: 'apex-studio-app-1',
      a2: 'apex-preview-app-one',
      a3: 'apex-preview-app-two',
    });

    await detachRuntimeApis(docker, 'apex-studio-network-1');

    const disconnected = docker.calls
      .filter((args) => args[1] === 'disconnect')
      .map((args) => args[args.length - 1]);
    expect(disconnected).toEqual([
      'apex-preview-app-one',
      'apex-preview-app-two',
    ]);
  });

  it('treats a missing Studio network as nothing to detach', async () => {
    const docker = new FakeDocker({}, true);

    await expect(
      detachRuntimeApis(docker, 'apex-studio-network-1')
    ).resolves.toBeUndefined();
  });
});
