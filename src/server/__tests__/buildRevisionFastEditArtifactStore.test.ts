import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalBuildRevisionFastEditArtifactStore,
  isAllowedFastEditPath,
} from '../services/build/buildRevisionFastEditArtifactStore';

describe('build revision fast-edit artifact store', () => {
  let root = '';
  let workspace = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'apex-fast-edit-artifacts-'));
    workspace = await mkdtemp(path.join(os.tmpdir(), 'apex-fast-edit-workspace-'));
    await mkdir(path.join(workspace, 'apps', 'web', 'src', 'features'), {
      recursive: true,
    });
    await writeFile(
      path.join(workspace, 'apps', 'web', 'src', 'features', 'Card.tsx'),
      'export const Card = () => <div>Updated</div>;\n',
    );
  });

  afterEach(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  });

  it('stores the same overlay at one content-addressed opaque reference', async () => {
    const store = createLocalBuildRevisionFastEditArtifactStore({
      artifactRoot: root,
      listChanges: async () => [
        { status: 'M', relativePath: 'apps/web/src/features/Card.tsx' },
      ],
    });

    const first = await store.materialize({
      workspacePath: workspace,
      baseCommit: 'a'.repeat(40),
    });
    const retry = await store.materialize({
      workspacePath: workspace,
      baseCommit: 'a'.repeat(40),
    });

    expect(retry.artifact).toEqual(first.artifact);
    expect(first.artifact.ref).toMatch(/^artifact:build-fast-edit:[0-9a-f]{64}$/);
    expect(first.artifact.ref).not.toContain(root);
    await expect(
      readFile(
        path.join(first.localPath, 'files', 'apps', 'web', 'src', 'features', 'Card.tsx'),
        'utf8',
      ),
    ).resolves.toContain('Updated');
  });

  it('records deletions without inventing an empty replacement file', async () => {
    const store = createLocalBuildRevisionFastEditArtifactStore({
      artifactRoot: root,
      listChanges: async () => [
        { status: 'D', relativePath: 'apps/web/src/features/OldCard.tsx' },
      ],
    });

    const result = await store.materialize({
      workspacePath: workspace,
      baseCommit: 'a'.repeat(40),
    });
    const manifest = JSON.parse(
      await readFile(path.join(result.localPath, 'manifest.json'), 'utf8'),
    );

    expect(manifest.deletePaths).toEqual([
      'apps/web/src/features/OldCard.tsx',
    ]);
  });

  it.each([
    'package.json',
    'apps/api/src/routes/cards.ts',
    'apps/web/src/api/apiClient.ts',
    'apps/web/src/config/env.ts',
    '.cursor/rules/build.mdc',
    '../outside.tsx',
  ])('rejects a fast edit outside the UI boundary: %s', (relativePath) => {
    expect(isAllowedFastEditPath(relativePath)).toBe(false);
  });

  it.each([
    'apps/web/src/features/Card.tsx',
    'apps/web/src/theme/overrides.ts',
    'packages/ui/src/Button.tsx',
  ])('allows contained UI source: %s', (relativePath) => {
    expect(isAllowedFastEditPath(relativePath)).toBe(true);
  });
});
