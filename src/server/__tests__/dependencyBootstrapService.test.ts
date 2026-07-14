import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  bootstrapDevelopmentDependencies,
  type DependencyCommandRunner,
} from '../services/dependencyBootstrapService';

async function makeWorkspace(
  root: string,
  name: string,
  lockVersion = '1',
  packageManager?: string
): Promise<string> {
  const workspace = path.join(root, name);
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', packageManager })
  );
  await fs.writeFile(
    path.join(workspace, 'package-lock.json'),
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages: {},
      lockVersion,
    })
  );
  return workspace;
}

async function addPnpmUnit(
  workspace: string,
  relativeDir: string,
  version = '9.15.4'
): Promise<string> {
  const unitDir = path.join(workspace, relativeDir);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(
    path.join(unitDir, 'package.json'),
    JSON.stringify({
      name: path.basename(unitDir),
      version: '1.0.0',
      packageManager: `pnpm@${version}`,
    })
  );
  await fs.writeFile(
    path.join(unitDir, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\nimporters:\n  .: {}\n"
  );
  return unitDir;
}

async function waitFor(
  assertion: () => void,
  timeoutMs = 2_000
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() - startedAt >= timeoutMs) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('dependencyBootstrapService', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'apex-deps-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runs the locked dev install exactly once and preserves production NODE_ENV', async () => {
    const workspace = await makeWorkspace(root, 'workspace-one');
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const runner: DependencyCommandRunner = jest.fn(
      async (command, args, options) => {
        expect(command).toBe('npm');
        expect(args).toEqual([
          'ci',
          '--include=dev',
          '--prefer-offline',
          '--no-audit',
          '--no-fund',
        ]);
        expect(options.env?.NODE_ENV).toBe('production');
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(options.cwd, 'node_modules', 'installed.txt'),
          'ready'
        );
      }
    );

    try {
      const result = await bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        nodeVersion: 'v24.1.0',
        commandRunner: runner,
      });

      expect(result.cacheHit).toBe(false);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(process.env.NODE_ENV).toBe('production');
      expect(
        await fs.readFile(
          path.join(workspace, 'node_modules', 'installed.txt'),
          'utf8'
        )
      ).toBe('ready');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('reuses a completed cache for the same Node version and lockfile', async () => {
    const workspaceOne = await makeWorkspace(root, 'workspace-one');
    const workspaceTwo = await makeWorkspace(root, 'workspace-two');
    const runner: DependencyCommandRunner = jest.fn(
      async (_command, _args, options) => {
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(options.cwd, 'node_modules', 'installed.txt'),
          'cached'
        );
      }
    );
    const options = {
      dataRoot: path.join(root, 'data'),
      nodeVersion: 'v24.1.0',
      commandRunner: runner,
      onPhase: jest.fn(),
    };

    const cold = await bootstrapDevelopmentDependencies(workspaceOne, options);
    const warm = await bootstrapDevelopmentDependencies(workspaceTwo, options);

    expect(cold.cacheHit).toBe(false);
    expect(warm.cacheHit).toBe(true);
    expect(warm.cacheKey).toBe(cold.cacheKey);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(options.onPhase).toHaveBeenNthCalledWith(
      1,
      'dependencies_preparing',
      expect.any(String)
    );
    expect(options.onPhase).toHaveBeenNthCalledWith(
      2,
      'dependencies_ready',
      expect.any(String)
    );
    expect(options.onPhase).toHaveBeenNthCalledWith(
      3,
      'dependencies_preparing',
      expect.any(String)
    );
    expect(options.onPhase).toHaveBeenNthCalledWith(
      4,
      'dependencies_ready',
      expect.any(String)
    );
    expect(await fs.realpath(path.join(workspaceTwo, 'node_modules'))).toBe(
      await fs.realpath(path.join(warm.cacheDir, 'node_modules'))
    );
  });

  it('serializes concurrent cache creation with a filesystem lock', async () => {
    const workspaceOne = await makeWorkspace(root, 'workspace-one');
    const workspaceTwo = await makeWorkspace(root, 'workspace-two');
    let releaseInstall!: () => void;
    const installBlocked = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const runner: DependencyCommandRunner = jest.fn(
      async (_command, _args, options) => {
        await installBlocked;
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
      }
    );
    const options = {
      dataRoot: path.join(root, 'data'),
      nodeVersion: 'v24.1.0',
      commandRunner: runner,
      lockPollMs: 1,
    };

    const first = bootstrapDevelopmentDependencies(workspaceOne, options);
    const second = bootstrapDevelopmentDependencies(workspaceTwo, options);
    await waitFor(() => expect(runner).toHaveBeenCalledTimes(1));

    releaseInstall();
    const results = await Promise.all([first, second]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.cacheHit)).toHaveLength(1);
  });

  it('invalidates the cache when package-lock.json changes', async () => {
    const workspaceOne = await makeWorkspace(root, 'workspace-one', 'one');
    const workspaceTwo = await makeWorkspace(root, 'workspace-two', 'two');
    const runner: DependencyCommandRunner = jest.fn(
      async (_command, _args, options) => {
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
      }
    );
    const options = {
      dataRoot: path.join(root, 'data'),
      nodeVersion: 'v24.1.0',
      commandRunner: runner,
    };

    const first = await bootstrapDevelopmentDependencies(workspaceOne, options);
    const second = await bootstrapDevelopmentDependencies(
      workspaceTwo,
      options
    );

    expect(first.cacheKey).not.toBe(second.cacheKey);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('rejects an unlocked workspace without running npm', async () => {
    const workspace = path.join(root, 'unlocked');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'package.json'), '{}');
    const runner: DependencyCommandRunner = jest.fn();

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: runner,
      })
    ).rejects.toThrow(/package-lock\.json/i);

    expect(runner).not.toHaveBeenCalled();
  });

  it('emits an actionable failure phase when npm ci fails', async () => {
    const workspace = await makeWorkspace(root, 'workspace-one');
    const onPhase = jest.fn();

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: jest
          .fn()
          .mockRejectedValue(new Error('registry unavailable')),
        onPhase,
      })
    ).rejects.toThrow(
      /npm ci --include=dev --prefer-offline --no-audit --no-fund.*registry unavailable/i
    );

    expect(onPhase).toHaveBeenLastCalledWith(
      'dependencies_failed',
      expect.stringMatching(/registry unavailable/i)
    );
  });

  it('discovers and installs a nested pinned pnpm unit', async () => {
    const workspace = path.join(root, 'polyglot');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'Api.csproj'), '<Project />');
    const clientDir = await addPnpmUnit(workspace, 'ClientApp');
    const runner: DependencyCommandRunner = jest.fn(
      async (command, args, options) => {
        expect(command).toBe('corepack');
        expect(args).toEqual([
          'pnpm@9.15.4',
          'install',
          '--frozen-lockfile',
          '--prod=false',
          '--prefer-offline',
        ]);
        expect(options.cwd).not.toBe(clientDir);
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(options.cwd, 'node_modules', 'pnpm.txt'),
          'ready'
        );
      }
    );

    const result = await bootstrapDevelopmentDependencies(workspace, {
      dataRoot: path.join(root, 'data'),
      nodeVersion: 'v24.1.0',
      commandRunner: runner,
    });

    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      relativeDir: 'ClientApp',
      packageManager: 'pnpm',
      packageManagerVersion: '9.15.4',
      cacheHit: false,
    });
    expect(
      await fs.readFile(
        path.join(clientDir, 'node_modules', 'pnpm.txt'),
        'utf8'
      )
    ).toBe('ready');
  });

  it('installs mixed npm and pnpm units once and attaches each subfolder cache', async () => {
    const workspace = await makeWorkspace(root, 'mixed', 'root');
    const mobileDir = path.join(workspace, 'mobile');
    await fs.mkdir(mobileDir);
    await fs.writeFile(
      path.join(mobileDir, 'package.json'),
      JSON.stringify({ name: 'mobile', version: '1.0.0' })
    );
    await fs.writeFile(
      path.join(mobileDir, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: {}, marker: 'mobile' })
    );
    const clientDir = await addPnpmUnit(workspace, 'ClientApp');
    const runner: DependencyCommandRunner = jest.fn(
      async (command, _args, options) => {
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(options.cwd, 'node_modules', `${command}.txt`),
          'ready'
        );
      }
    );

    const result = await bootstrapDevelopmentDependencies(workspace, {
      dataRoot: path.join(root, 'data'),
      commandRunner: runner,
    });

    expect(
      result.units.map((unit) => `${unit.relativeDir}:${unit.packageManager}`)
    ).toEqual(['.:npm', 'ClientApp:pnpm', 'mobile:npm']);
    expect(runner).toHaveBeenCalledTimes(3);
    await expect(
      fs.realpath(path.join(workspace, 'node_modules'))
    ).resolves.toBe(
      await fs.realpath(path.join(result.units[0].cacheDir, 'node_modules'))
    );
    await expect(
      fs.realpath(path.join(clientDir, 'node_modules'))
    ).resolves.toBe(
      await fs.realpath(path.join(result.units[1].cacheDir, 'node_modules'))
    );
    await expect(
      fs.realpath(path.join(mobileDir, 'node_modules'))
    ).resolves.toBe(
      await fs.realpath(path.join(result.units[2].cacheDir, 'node_modules'))
    );
  });

  it('ignores lockfiles under excluded build artifacts and duplicate dependency trees', async () => {
    const workspace = await makeWorkspace(root, 'workspace-one');
    await makeWorkspace(workspace, 'node_modules/ignored');
    await makeWorkspace(workspace, 'build/generated');
    const runner: DependencyCommandRunner = jest.fn(
      async (_command, _args, options) => {
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
      }
    );

    const result = await bootstrapDevelopmentDependencies(workspace, {
      dataRoot: path.join(root, 'data'),
      commandRunner: runner,
    });

    expect(result.units).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('includes install folder and package-manager version in cache identity', async () => {
    const workspace = await makeWorkspace(
      root,
      'workspace-one',
      'same',
      'npm@10.9.2'
    );
    const nested = path.join(workspace, 'nested');
    await fs.mkdir(nested);
    await fs.copyFile(
      path.join(workspace, 'package.json'),
      path.join(nested, 'package.json')
    );
    await fs.copyFile(
      path.join(workspace, 'package-lock.json'),
      path.join(nested, 'package-lock.json')
    );
    const runner: DependencyCommandRunner = jest.fn(
      async (_command, _args, options) => {
        await fs.mkdir(path.join(options.cwd, 'node_modules'), {
          recursive: true,
        });
      }
    );

    const result = await bootstrapDevelopmentDependencies(workspace, {
      dataRoot: path.join(root, 'data'),
      nodeVersion: 'v24.1.0',
      commandRunner: runner,
    });

    expect(result.units[0].cacheKey).not.toBe(result.units[1].cacheKey);
    expect(
      result.units.every((unit) => unit.cacheKey.includes('npm-10.9.2'))
    ).toBe(true);
  });

  it('rejects a packageManager and lockfile conflict before running commands', async () => {
    const workspace = await makeWorkspace(
      root,
      'conflict',
      'one',
      'pnpm@9.15.4'
    );
    const runner: DependencyCommandRunner = jest.fn();

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: runner,
      })
    ).rejects.toThrow(/packageManager.*pnpm.*package-lock\.json.*npm/i);
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects multiple manager lockfiles in the same install folder', async () => {
    const workspace = await makeWorkspace(root, 'conflict');
    await fs.writeFile(
      path.join(workspace, 'pnpm-lock.yaml'),
      "lockfileVersion: '9.0'\n"
    );

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: jest.fn(),
      })
    ).rejects.toThrow(/multiple.*lockfiles.*same.*folder/i);
  });

  it('fails explicitly when a successful manager command creates no node_modules', async () => {
    const workspace = await makeWorkspace(root, 'missing-output');

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: jest.fn().mockResolvedValue(undefined),
      })
    ).rejects.toThrow(/completed without creating node_modules/i);
  });

  it('treats a .NET-only repository as having no JavaScript install units', async () => {
    const workspace = path.join(root, 'dotnet-only');
    await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, 'src', 'Api.csproj'),
      '<Project />'
    );

    const result = await bootstrapDevelopmentDependencies(workspace, {
      dataRoot: path.join(root, 'data'),
      commandRunner: jest.fn(),
    });

    expect(result.units).toEqual([]);
    expect(result.cacheHit).toBe(true);
  });

  it('rejects pnpm workspaces until their linked install topology can be cached safely', async () => {
    const workspace = path.join(root, 'pnpm-workspace');
    await fs.mkdir(workspace);
    await addPnpmUnit(workspace, '.');
    await fs.writeFile(
      path.join(workspace, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n"
    );

    await expect(
      bootstrapDevelopmentDependencies(workspace, {
        dataRoot: path.join(root, 'data'),
        commandRunner: jest.fn(),
      })
    ).rejects.toThrow(/pnpm workspace.*not supported.*safely/i);
  });
});
