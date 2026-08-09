import { DIAGRAM_MAX_THUMBNAIL_BYTES } from '../../../shared/types/diagram';
import { EMPTY_DIAGRAM_THUMBNAIL } from '../diagramScene';
import {
  DIAGRAM_MAX_THUMBNAIL_DIMENSION,
  generateDiagramThumbnail,
} from '../diagramThumbnail';

describe('diagramThumbnail — TBI-005 DoD-3 / VT-09 thumbnail failure', () => {
  it('exposes the agreed 512×512 client dimension bound', () => {
    expect(DIAGRAM_MAX_THUMBNAIL_DIMENSION).toBe(512);
    expect(DIAGRAM_MAX_THUMBNAIL_BYTES).toBe(512 * 1024);
  });

  it('DoD-3 / VT-09: thumbnail export failure returns empty placeholder without throwing', async () => {
    await expect(
      generateDiagramThumbnail({
        exportPngBlob: async () => {
          throw new Error('export failed');
        },
      }),
    ).resolves.toBe(EMPTY_DIAGRAM_THUMBNAIL);
  });

  it('DoD-3 / VT-09: successful export that cannot be bounded still returns placeholder', async () => {
    await expect(
      generateDiagramThumbnail({
        exportPngBlob: async () => new Blob(['not-a-png'], { type: 'image/png' }),
      }),
    ).resolves.toBe(EMPTY_DIAGRAM_THUMBNAIL);
  });
});
