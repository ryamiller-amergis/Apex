/**
 * Server-side service for session-scoped electronic signature PNG assets.
 *
 * Design constraints (from the plan):
 * - PNG only (after client normalisation).  Never log image bytes or embed
 *   base64 in JSON — binary is stored exclusively via pdfArtifactStore.
 * - Per-session limits: 2 MB, 16–4096 px per side, 15 assets, 20 placements.
 * - Asset IDs are UUIDs used as the artifact file name.
 * - Binary cleanup happens via the existing deleteSessionPrefix path.
 */
import crypto from 'crypto';
import { getPdfArtifactStore } from './pdfArtifactStore';
import type { PdfArtifactRef } from './pdfArtifactStore';
import type {
  PdfSignatureAsset,
  PdfSignatureOverlay,
  PdfSignatureState,
} from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── Limits ─────────────────────────────────────────────────────────────────────

export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 2 MB
export const MIN_SIGNATURE_DIMENSION_PX = 16;
export const MAX_SIGNATURE_DIMENSION_PX = 4096;
export const MAX_SIGNATURE_ASSETS_PER_SESSION = 15;
export const MAX_SIGNATURE_OVERLAYS_PER_SESSION = 20;

// ── PNG parsing ────────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Returns `{ widthPx, heightPx }` by reading the PNG IHDR chunk.
 * Throws a coded error if the buffer is not a valid PNG or the dimensions are
 * outside the allowed range.
 */
export function parsePngDimensions(buffer: Buffer): {
  widthPx: number;
  heightPx: number;
} {
  if (buffer.length < 24) {
    throw Object.assign(new Error('File is not a valid PNG.'), {
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID,
    });
  }

  // Verify magic bytes
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== PNG_MAGIC[i]) {
      throw Object.assign(new Error('File is not a PNG.'), {
        code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID,
      });
    }
  }

  // The IHDR chunk always starts at byte 8.
  // Bytes 8–11: chunk data length (must be 13 for IHDR)
  // Bytes 12–15: chunk type ("IHDR")
  // Bytes 16–19: width
  // Bytes 20–23: height
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw Object.assign(new Error('PNG is missing required IHDR chunk.'), {
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID,
    });
  }

  const widthPx = buffer.readUInt32BE(16);
  const heightPx = buffer.readUInt32BE(20);

  if (
    widthPx < MIN_SIGNATURE_DIMENSION_PX ||
    widthPx > MAX_SIGNATURE_DIMENSION_PX ||
    heightPx < MIN_SIGNATURE_DIMENSION_PX ||
    heightPx > MAX_SIGNATURE_DIMENSION_PX
  ) {
    throw Object.assign(
      new Error(
        `Signature image dimensions must be between ` +
          `${MIN_SIGNATURE_DIMENSION_PX} and ${MAX_SIGNATURE_DIMENSION_PX} px. ` +
          `Got ${widthPx}×${heightPx}.`
      ),
      { code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID }
    );
  }

  return { widthPx, heightPx };
}

// ── Asset file name ────────────────────────────────────────────────────────────

function assetFileName(assetId: string): string {
  return `sig-${assetId}.png`;
}

export function buildSignatureArtifactRef(
  userId: string,
  sessionId: string,
  assetId: string
): PdfArtifactRef {
  return { userId, sessionId, fileName: assetFileName(assetId) };
}

// ── Upload ─────────────────────────────────────────────────────────────────────

/**
 * Validates `buffer`, stores it via the artifact store, and returns the new
 * `PdfSignatureAsset` metadata. Callers must pass the current asset list so the
 * per-session asset cap can be enforced.
 *
 * Never throws PII or image bytes in the returned error messages.
 */
export async function uploadSignatureAsset(
  userId: string,
  sessionId: string,
  buffer: Buffer,
  currentAssets: PdfSignatureAsset[]
): Promise<PdfSignatureAsset> {
  if (buffer.length > MAX_SIGNATURE_BYTES) {
    throw Object.assign(
      new Error(
        `Signature image must be ${MAX_SIGNATURE_BYTES / 1024 / 1024} MB or smaller.`
      ),
      { code: PDF_ERROR_CODES.SIGNATURE_ASSET_TOO_LARGE }
    );
  }

  if (currentAssets.length >= MAX_SIGNATURE_ASSETS_PER_SESSION) {
    throw Object.assign(
      new Error(
        `A session may have at most ${MAX_SIGNATURE_ASSETS_PER_SESSION} signature images.`
      ),
      { code: PDF_ERROR_CODES.SIGNATURE_ASSET_LIMIT_EXCEEDED }
    );
  }

  const { widthPx, heightPx } = parsePngDimensions(buffer);

  const assetId = crypto.randomUUID();
  const ref = buildSignatureArtifactRef(userId, sessionId, assetId);
  await getPdfArtifactStore().putFile(ref, buffer);

  return {
    assetId,
    source: 'uploaded',
    widthPx,
    heightPx,
    uploadedAt: new Date().toISOString(),
  };
}

// ── Stream for preview ─────────────────────────────────────────────────────────

/**
 * Streams a stored signature PNG asset by `assetId`.
 * Throws `SIGNATURE_ASSET_NOT_FOUND` when the asset does not exist.
 */
export async function streamSignatureAsset(
  userId: string,
  sessionId: string,
  assetId: string
): Promise<NodeJS.ReadableStream> {
  const ref = buildSignatureArtifactRef(userId, sessionId, assetId);
  const store = getPdfArtifactStore();
  const exists = await store.exists(ref);
  if (!exists) {
    throw Object.assign(new Error('Signature asset not found.'), {
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_NOT_FOUND,
    });
  }
  return store.getStream(ref);
}

// ── Overlay validation ─────────────────────────────────────────────────────────

function isPercentage(value: number): boolean {
  return typeof value === 'number' && value >= 0 && value <= 100;
}

const VALID_ROTATIONS = new Set([0, 90, 180, 270]);

/**
 * Validates an array of signature overlays against the session's current asset
 * catalog and page manifest page IDs.
 *
 * Returns an array of human-readable error messages, or an empty array when all
 * overlays are valid.
 */
export function validateSignatureOverlays(
  overlays: unknown[],
  knownAssetIds: Set<string>,
  knownPageIds: Set<string>
): string[] {
  if (overlays.length > MAX_SIGNATURE_OVERLAYS_PER_SESSION) {
    return [
      `A session may have at most ${MAX_SIGNATURE_OVERLAYS_PER_SESSION} signature placements.`,
    ];
  }

  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < overlays.length; i++) {
    const o = overlays[i] as Record<string, unknown>;
    const prefix = `Overlay[${i}]:`;

    if (!o || typeof o !== 'object') {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (typeof o.id !== 'string' || !o.id) {
      errors.push(`${prefix} id must be a non-empty string.`);
    } else if (seenIds.has(o.id)) {
      errors.push(`${prefix} duplicate id "${o.id}".`);
    } else {
      seenIds.add(o.id as string);
    }
    if (typeof o.assetId !== 'string' || !knownAssetIds.has(o.assetId as string)) {
      errors.push(`${prefix} assetId "${o.assetId}" not found in session assets.`);
    }
    if (typeof o.pageId !== 'string' || !knownPageIds.has(o.pageId as string)) {
      errors.push(`${prefix} pageId "${o.pageId}" not found in session manifest.`);
    }
    if (!isPercentage(o.x as number)) errors.push(`${prefix} x must be 0–100.`);
    if (!isPercentage(o.y as number)) errors.push(`${prefix} y must be 0–100.`);
    if (
      typeof o.width !== 'number' ||
      o.width <= 0 ||
      (o.x as number) + (o.width as number) > 100
    ) {
      errors.push(`${prefix} width must be positive and x+width ≤ 100.`);
    }
    if (
      typeof o.height !== 'number' ||
      o.height <= 0 ||
      (o.y as number) + (o.height as number) > 100
    ) {
      errors.push(`${prefix} height must be positive and y+height ≤ 100.`);
    }
    if (!VALID_ROTATIONS.has(o.rotation as number)) {
      errors.push(`${prefix} rotation must be 0, 90, 180, or 270.`);
    }
    if (
      typeof o.opacity !== 'number' ||
      o.opacity < 0 ||
      o.opacity > 100
    ) {
      errors.push(`${prefix} opacity must be 0–100.`);
    }
    if (typeof o.zIndex !== 'number') {
      errors.push(`${prefix} zIndex must be a number.`);
    }
  }

  return errors;
}

// ── Assemble asset→ref map for export ─────────────────────────────────────────

/**
 * Returns a Record<assetId, PdfArtifactRef> for all assets referenced by
 * `overlays`, restricted to those that actually appear in `signatureState`.
 */
export function buildSignatureArtifactRefs(
  userId: string,
  sessionId: string,
  state: PdfSignatureState
): Record<string, PdfArtifactRef> {
  const refs: Record<string, PdfArtifactRef> = {};
  for (const asset of state.assets) {
    refs[asset.assetId] = buildSignatureArtifactRef(
      userId,
      sessionId,
      asset.assetId
    );
  }
  return refs;
}

// ── Orphan cleanup ─────────────────────────────────────────────────────────────

/**
 * Removes placements whose assetId no longer exists in the asset list, or whose
 * pageId is no longer present in the active page manifest.
 */
export function stripOrphanedOverlays(
  state: PdfSignatureState,
  knownPageIds?: Set<string>
): PdfSignatureState {
  const validIds = new Set(state.assets.map((a) => a.assetId));
  const overlays = state.overlays.filter(
    (o) =>
      validIds.has(o.assetId) &&
      (!knownPageIds || knownPageIds.has(o.pageId))
  );
  if (overlays.length === state.overlays.length) return state;
  return { assets: state.assets, overlays };
}

/**
 * Removes assets that are not referenced by any placement. When
 * `retainUnreferencedSince` is supplied, recently-uploaded assets are retained
 * so an upload and its immediately-following overlay save cannot race cleanup.
 */
export function pruneUnreferencedSignatureAssets(
  state: PdfSignatureState,
  retainUnreferencedSince?: number
): PdfSignatureState {
  const referencedAssetIds = new Set(
    state.overlays.map((overlay) => overlay.assetId)
  );
  const assets = state.assets.filter((asset) => {
    if (referencedAssetIds.has(asset.assetId)) return true;
    if (retainUnreferencedSince === undefined) return false;
    const uploadedAt = Date.parse(asset.uploadedAt);
    return Number.isFinite(uploadedAt) && uploadedAt >= retainUnreferencedSince;
  });
  if (assets.length === state.assets.length) return state;
  return { assets, overlays: state.overlays };
}
