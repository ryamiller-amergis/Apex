import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installGoldenStackStudioAdapter } from '../services/build/buildEditablePreviewLocalService';

describe('local editable preview adapter', () => {
  it('builds workspace packages before starting Vite so linked exports exist', async () => {
    const dockerfile = await readFile(
      path.resolve(
        process.cwd(),
        'templates',
        'full-stack-express',
        'Dockerfile.studio'
      ),
      'utf8'
    );
    const contractsBuild = dockerfile.indexOf(
      'corepack pnpm --filter @project-scope/contracts build'
    );
    const uiBuild = dockerfile.indexOf(
      'corepack pnpm --filter @project-scope/ui build'
    );
    const viteStart = dockerfile.indexOf('exec", "vite"');

    expect(contractsBuild).toBeGreaterThan(-1);
    expect(uiBuild).toBeGreaterThan(contractsBuild);
    expect(viteStart).toBeGreaterThan(uiBuild);
  });

  it('keeps test source in the Studio image used by isolated quality tasks', async () => {
    const dockerignore = await readFile(
      path.resolve(
        process.cwd(),
        'templates',
        'full-stack-express',
        'Dockerfile.studio.dockerignore'
      ),
      'utf8'
    );

    expect(dockerignore).not.toMatch(/\*\*\/\*\.test\./);
    expect(dockerignore).not.toMatch(/\*\*\/__tests__/);
  });

  it('adds Studio runtime files without replacing application source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studio-adapter-'));
    const workspace = path.join(root, 'workspace');
    const adapter = path.join(root, 'adapter');
    try {
      await Promise.all([
        mkdir(path.join(workspace, 'apps', 'web', 'src'), {
          recursive: true,
        }),
        mkdir(path.join(adapter, 'scripts', 'preview'), {
          recursive: true,
        }),
      ]);
      await Promise.all([
        writeFile(path.join(workspace, 'package.json'), '{"name":"generated"}'),
        writeFile(
          path.join(workspace, 'apps', 'web', 'src', 'App.tsx'),
          'export const App = () => "exact app";'
        ),
        writeFile(
          path.join(adapter, 'apex.preview.json'),
          '{"schemaVersion":1,"development":{"dockerfile":"Dockerfile.studio"}}'
        ),
        writeFile(
          path.join(adapter, 'Dockerfile.studio'),
          'FROM node:24-bookworm-slim'
        ),
        writeFile(
          path.join(adapter, 'Dockerfile.studio.dockerignore'),
          '**/node_modules\n'
        ),
        writeFile(
          path.join(adapter, 'scripts', 'preview', 'runner-tcp-proxy.mjs'),
          'export {};'
        ),
        writeFile(
          path.join(adapter, 'scripts', 'preview', 'studio-runner.mjs'),
          'export {};'
        ),
      ]);

      await installGoldenStackStudioAdapter(workspace, adapter);

      await expect(
        readFile(path.join(workspace, 'apps', 'web', 'src', 'App.tsx'), 'utf8')
      ).resolves.toBe('export const App = () => "exact app";');
      await expect(
        readFile(path.join(workspace, 'Dockerfile.studio'), 'utf8')
      ).resolves.toContain('node:24');
      await expect(
        readFile(path.join(workspace, 'Dockerfile.studio.dockerignore'), 'utf8')
      ).resolves.toBe('**/node_modules\n');
      await expect(
        readFile(
          path.join(workspace, 'scripts', 'preview', 'runner-tcp-proxy.mjs'),
          'utf8'
        )
      ).resolves.toBe('export {};');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('updates the provider-owned Studio runner in an existing preview scripts directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'studio-runner-'));
    const workspace = path.join(root, 'workspace');
    const adapter = path.join(root, 'adapter');
    const relativeRunner = path.join('scripts', 'preview', 'studio-runner.mjs');
    try {
      await Promise.all([
        mkdir(path.join(workspace, 'apps', 'web'), { recursive: true }),
        mkdir(path.join(workspace, 'scripts', 'preview'), { recursive: true }),
        mkdir(path.join(adapter, 'scripts', 'preview'), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(path.join(workspace, 'package.json'), '{"name":"generated"}'),
        writeFile(path.join(workspace, relativeRunner), 'stale runner'),
        writeFile(path.join(adapter, relativeRunner), 'current runner'),
        writeFile(path.join(adapter, 'apex.preview.json'), '{}'),
        writeFile(path.join(adapter, 'Dockerfile.studio'), 'FROM node:24'),
        writeFile(
          path.join(adapter, 'Dockerfile.studio.dockerignore'),
          'node_modules\n'
        ),
      ]);

      await installGoldenStackStudioAdapter(workspace, adapter);

      await expect(
        readFile(path.join(workspace, relativeRunner), 'utf8')
      ).resolves.toBe('current runner');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
