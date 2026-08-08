import { DIAGRAM_MAX_THUMBNAIL_BYTES } from '../../shared/types/diagram';
import { EMPTY_DIAGRAM_THUMBNAIL } from './diagramScene';

/** Client-side max edge length for PNG thumbnails (aligned with FEAT-003 assumption). */
export const DIAGRAM_MAX_THUMBNAIL_DIMENSION = 512;

export type ThumbnailSource = {
  /**
   * Produces a PNG blob of the current canvas. Injected so unit tests can
   * force success/failure without mounting Excalidraw.
   */
  exportPngBlob: () => Promise<Blob>;
};

function decodePngByteLength(dataUrl: string): number {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) return Number.POSITIVE_INFINITY;
  const binary = atob(match[1]);
  return binary.length;
}

/**
 * Downscale a PNG blob to fit within DIAGRAM_MAX_THUMBNAIL_DIMENSION and the
 * shared DIAGRAM_MAX_THUMBNAIL_BYTES cap. Returns null when the browser canvas
 * APIs are unavailable or the image cannot be processed.
 */
export async function boundPngThumbnail(blob: Blob): Promise<string | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') {
    return null;
  }

  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(
      1,
      DIAGRAM_MAX_THUMBNAIL_DIMENSION / Math.max(bitmap.width, 1),
      DIAGRAM_MAX_THUMBNAIL_DIMENSION / Math.max(bitmap.height, 1),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    let quality = 0.92;
    let dataUrl = canvas.toDataURL('image/png');
    // PNG ignores quality; if still over budget, shrink dimensions further.
    while (
      decodePngByteLength(dataUrl) > DIAGRAM_MAX_THUMBNAIL_BYTES
      && Math.min(canvas.width, canvas.height) > 32
    ) {
      canvas.width = Math.max(32, Math.round(canvas.width * 0.75));
      canvas.height = Math.max(32, Math.round(canvas.height * 0.75));
      const shrinkCtx = canvas.getContext('2d');
      if (!shrinkCtx) return null;
      const rebuilt = await createImageBitmap(blob);
      shrinkCtx.clearRect(0, 0, canvas.width, canvas.height);
      shrinkCtx.drawImage(rebuilt, 0, 0, canvas.width, canvas.height);
      rebuilt.close();
      dataUrl = canvas.toDataURL('image/png');
      quality -= 0.1;
      if (quality < 0.4) break;
    }

    if (decodePngByteLength(dataUrl) > DIAGRAM_MAX_THUMBNAIL_BYTES) {
      return null;
    }
    return dataUrl;
  } catch {
    return null;
  }
}

/**
 * Generate a bounded PNG data URL for save. On any failure, returns the empty
 * placeholder so persistence can still succeed (TBI-005 thumbnail failure DoD).
 */
export async function generateDiagramThumbnail(
  source: ThumbnailSource,
): Promise<string> {
  try {
    const blob = await source.exportPngBlob();
    const bounded = await boundPngThumbnail(blob);
    if (bounded) return bounded;
    return EMPTY_DIAGRAM_THUMBNAIL;
  } catch {
    return EMPTY_DIAGRAM_THUMBNAIL;
  }
}
