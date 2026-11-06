/**
 * buildPreviewArtifactService tests (sandbox preview bundles).
 */
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  buildPreviewPublicUrl,
  resolvePreviewAssetPath,
  storePreviewArchive,
  verifyPreviewToken,
} from '../services/buildPreviewArtifactService';

jest.mock('../utils/dataDir', () => ({
  resolveDataRoot: () => path.join(process.cwd(), 'data', 'test-preview-artifacts'),
}));

const execFileAsync = promisify(execFile);

describe('buildPreviewArtifactService', () => {
  const buildRunId = '00000000-0000-4000-8000-000000000099';

  beforeEach(async () => {
    await fs.rm(path.join(process.cwd(), 'data', 'test-preview-artifacts'), {
      recursive: true,
      force: true,
    });
  });

  it('stores a tar.gz bundle, verifies the token, and rejects traversal paths', async () => {
    const tmp = await fs.mkdtemp(path.join(process.cwd(), 'preview-tar-'));
    const dist = path.join(tmp, 'dist');
    await fs.mkdir(dist, { recursive: true });
    await fs.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Preview</title>', 'utf8');
    const archivePath = path.join(tmp, 'bundle.tar.gz');
    await execFileAsync('tar', ['-czf', archivePath, '-C', dist, '.'], { windowsHide: true });
    const archive = await fs.readFile(archivePath);

    const { token, previewUrl } = await storePreviewArchive({
      buildRunId,
      revisionNumber: 1,
      commit: 'a'.repeat(40),
      archive,
    });

    expect(previewUrl).toBe(buildPreviewPublicUrl(buildRunId, token));
    const manifest = await verifyPreviewToken(buildRunId, token);
    expect(manifest?.revisionNumber).toBe(1);
    expect(await resolvePreviewAssetPath(buildRunId, token, '../index.html')).toBeNull();
  });
});
