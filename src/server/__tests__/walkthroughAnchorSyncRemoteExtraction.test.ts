/**
 * Remote (github|ado) Sync extraction after caller materializes Apex skill repo.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractWalkthroughAnchorsFromFiles,
  syncExtractWalkthroughAnchors,
} from '../services/walkthroughAnchorSyncExtraction';

describe('syncExtractWalkthroughAnchors remote providers', () => {
  it('uses pre-fetched files and marks committedTruth', async () => {
    const result = await syncExtractWalkthroughAnchors({
      provider: 'github',
      catalogSnapshot: [],
      branch: 'main',
      committedTruth: true,
      files: [
        {
          path: 'src/client/components/Remote.tsx',
          content: `<button {...{ 'data-testid': 'remote-button' }} />\n`,
        },
      ],
    });

    expect(result.newCandidates.map((d) => d.testId)).toEqual([
      'remote-button',
    ]);
    expect(result.diagnostics.provider).toBe('github');
    expect(result.diagnostics.committedTruth).toBe(true);
    expect(result.diagnostics.branch).toBe('main');
  });

  it('scans a materialized repositoryRoot for github without files', async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'apex-anchor-sync-remote-')
    );
    try {
      const clientRoot = path.join(tmpRoot, 'src', 'client');
      fs.mkdirSync(clientRoot, { recursive: true });
      fs.writeFileSync(
        path.join(clientRoot, 'FromCache.tsx'),
        `<button {...{ 'data-testid': 'from-cache-button' }} />\n`,
        'utf8'
      );

      const result = await syncExtractWalkthroughAnchors({
        provider: 'github',
        catalogSnapshot: [],
        repositoryRoot: tmpRoot,
        branch: 'main',
        committedTruth: true,
      });

      expect(result.newCandidates.map((d) => d.testId)).toEqual([
        'from-cache-button',
      ]);
      expect(result.diagnostics.provider).toBe('github');
      expect(result.diagnostics.committedTruth).toBe(true);
      expect(result.diagnostics.branch).toBe('main');
      expect(result.diagnostics.rootPath).toBe(path.resolve(tmpRoot));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects remote sync without repositoryRoot or files', async () => {
    await expect(
      syncExtractWalkthroughAnchors({
        provider: 'github',
        catalogSnapshot: [],
      })
    ).rejects.toThrow(/materialized repositoryRoot or pre-fetched files/);
  });

  it('extractWalkthroughAnchorsFromFiles records remote diagnostics', () => {
    const result = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/Remote.tsx',
          content: `<button {...{ 'data-testid': 'remote-button' }} />\n`,
        },
      ],
      {
        provider: 'ado',
        catalogSnapshot: [],
        branch: 'develop',
        committedTruth: true,
      }
    );
    expect(result.diagnostics.provider).toBe('ado');
    expect(result.diagnostics.committedTruth).toBe(true);
    expect(result.diagnostics.branch).toBe('develop');
  });
});
