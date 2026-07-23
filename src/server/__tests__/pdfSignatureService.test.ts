/**
 * Unit tests for pdfSignatureService — PNG validation, asset upload, overlay
 * validation, and orphan cleanup.
 *
 * Tests do NOT hit the database; the artifact store is replaced with an
 * in-memory fake via setPdfArtifactStoreForTests.
 */
import crypto from 'crypto';
import * as pdfSignatureService from '../services/pdfSignatureService';
import {
  parsePngDimensions,
  uploadSignatureAsset,
  validateSignatureOverlays,
  stripOrphanedOverlays,
  MAX_SIGNATURE_BYTES,
  MAX_SIGNATURE_ASSETS_PER_SESSION,
  MAX_SIGNATURE_OVERLAYS_PER_SESSION,
  MIN_SIGNATURE_DIMENSION_PX,
  MAX_SIGNATURE_DIMENSION_PX,
} from '../services/pdfSignatureService';
import { setPdfArtifactStoreForTests } from '../services/pdfArtifactStore';
import type { PdfSignatureAsset, PdfSignatureState } from '../../shared/types/pdf';
import { PDF_ERROR_CODES } from '../../shared/types/pdf';

// ── PNG test helpers ────────────────────────────────────────────────────────────

function buildPngBuffer(widthPx: number, heightPx: number): Buffer {
  // Minimal valid PNG: signature + IHDR chunk + IEND chunk
  const buf = Buffer.alloc(33 + 12); // sig(8) + IHDR chunk(25) + IEND chunk(12)

  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);

  // IHDR: length(4) + type(4) + data(13) + crc(4) = 25 bytes
  buf.writeUInt32BE(13, 8);                  // chunk data length = 13
  buf.write('IHDR', 12, 'ascii');            // chunk type
  buf.writeUInt32BE(widthPx, 16);            // width
  buf.writeUInt32BE(heightPx, 20);           // height
  buf[24] = 8;                               // bit depth
  buf[25] = 2;                               // color type (RGB)
  // bytes 26–28: compression, filter, interlace methods (all 0)
  // bytes 29–32: CRC (we don't compute a real CRC — parsePngDimensions doesn't check it)

  // IEND: length(4=0) + type(4) + crc(4) = 12 bytes (at offset 33)
  buf.writeUInt32BE(0, 33);
  buf.write('IEND', 37, 'ascii');

  return buf;
}

// ── In-memory artifact store stub ──────────────────────────────────────────────

function makeMemoryStore() {
  const files = new Map<string, Buffer>();
  return {
    async putFile(ref: { userId: string; sessionId: string; fileName: string }, source: Buffer) {
      files.set(`${ref.userId}/${ref.sessionId}/${ref.fileName}`, source);
    },
    async getStream() { throw new Error('getStream not used in unit tests'); },
    async exists(ref: { userId: string; sessionId: string; fileName: string }) {
      return files.has(`${ref.userId}/${ref.sessionId}/${ref.fileName}`);
    },
    async deleteFile() {},
    async deleteSessionPrefix() {},
    files,
  };
}

// ── parsePngDimensions ─────────────────────────────────────────────────────────

describe('parsePngDimensions', () => {
  it('parses width and height from a valid PNG IHDR', () => {
    const buf = buildPngBuffer(200, 100);
    const result = parsePngDimensions(buf);
    expect(result).toEqual({ widthPx: 200, heightPx: 100 });
  });

  it('throws SIGNATURE_ASSET_INVALID for a non-PNG magic byte', () => {
    const buf = Buffer.alloc(24, 0);
    buf.write('%PDF', 0, 'ascii');
    expect(() => parsePngDimensions(buf)).toThrow(
      expect.objectContaining({ code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID })
    );
  });

  it('throws SIGNATURE_ASSET_INVALID for a buffer that is too short', () => {
    const buf = Buffer.from([0x89, 0x50]);
    expect(() => parsePngDimensions(buf)).toThrow(
      expect.objectContaining({ code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID })
    );
  });

  it('throws SIGNATURE_ASSET_INVALID when a dimension is below the minimum', () => {
    const buf = buildPngBuffer(MIN_SIGNATURE_DIMENSION_PX - 1, 200);
    expect(() => parsePngDimensions(buf)).toThrow(
      expect.objectContaining({ code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID })
    );
  });

  it('throws SIGNATURE_ASSET_INVALID when a dimension exceeds the maximum', () => {
    const buf = buildPngBuffer(200, MAX_SIGNATURE_DIMENSION_PX + 1);
    expect(() => parsePngDimensions(buf)).toThrow(
      expect.objectContaining({ code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID })
    );
  });

  it('accepts the exact boundary dimensions', () => {
    const minBuf = buildPngBuffer(MIN_SIGNATURE_DIMENSION_PX, MIN_SIGNATURE_DIMENSION_PX);
    const maxBuf = buildPngBuffer(MAX_SIGNATURE_DIMENSION_PX, MAX_SIGNATURE_DIMENSION_PX);
    expect(parsePngDimensions(minBuf)).toEqual({
      widthPx: MIN_SIGNATURE_DIMENSION_PX,
      heightPx: MIN_SIGNATURE_DIMENSION_PX,
    });
    expect(parsePngDimensions(maxBuf)).toEqual({
      widthPx: MAX_SIGNATURE_DIMENSION_PX,
      heightPx: MAX_SIGNATURE_DIMENSION_PX,
    });
  });
});

// ── uploadSignatureAsset ───────────────────────────────────────────────────────

describe('uploadSignatureAsset', () => {
  let store: ReturnType<typeof makeMemoryStore>;

  beforeEach(() => {
    store = makeMemoryStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPdfArtifactStoreForTests(store as any);
  });

  afterEach(() => {
    setPdfArtifactStoreForTests(undefined);
  });

  it('stores a valid PNG and returns asset metadata', async () => {
    const buf = buildPngBuffer(300, 150);
    const asset = await uploadSignatureAsset('user1', 'sess1', buf, []);

    expect(asset.widthPx).toBe(300);
    expect(asset.heightPx).toBe(150);
    expect(asset.source).toBe('uploaded');
    expect(typeof asset.assetId).toBe('string');
    expect(asset.assetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.files.size).toBe(1);
  });

  it('throws SIGNATURE_ASSET_TOO_LARGE when buffer exceeds the size limit', async () => {
    const buf = Buffer.alloc(MAX_SIGNATURE_BYTES + 1);
    await expect(uploadSignatureAsset('user1', 'sess1', buf, [])).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_TOO_LARGE,
    });
  });

  it('throws SIGNATURE_ASSET_LIMIT_EXCEEDED when the session is at capacity', async () => {
    const existing: PdfSignatureAsset[] = Array.from(
      { length: MAX_SIGNATURE_ASSETS_PER_SESSION },
      () => ({
        assetId: crypto.randomUUID(),
        source: 'uploaded' as const,
        widthPx: 100,
        heightPx: 100,
        uploadedAt: new Date().toISOString(),
      })
    );
    const buf = buildPngBuffer(100, 100);
    await expect(uploadSignatureAsset('user1', 'sess1', buf, existing)).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_LIMIT_EXCEEDED,
    });
  });

  it('allows up to fifteen stored signature images', () => {
    expect(MAX_SIGNATURE_ASSETS_PER_SESSION).toBe(15);
  });

  it('throws SIGNATURE_ASSET_INVALID for a non-PNG file', async () => {
    const buf = Buffer.from('this is not a png');
    await expect(uploadSignatureAsset('user1', 'sess1', buf, [])).rejects.toMatchObject({
      code: PDF_ERROR_CODES.SIGNATURE_ASSET_INVALID,
    });
  });
});

// ── validateSignatureOverlays ─────────────────────────────────────────────────

describe('validateSignatureOverlays', () => {
  const assetId = 'asset-1';
  const pageId = 'page-1';
  const knownAssets = new Set([assetId]);
  const knownPages = new Set([pageId]);

  const validOverlay = {
    id: 'ov-1',
    pageId,
    assetId,
    x: 10,
    y: 10,
    width: 20,
    height: 15,
    rotation: 0,
    opacity: 100,
    zIndex: 1,
  };

  it('returns no errors for a single valid overlay', () => {
    const errors = validateSignatureOverlays([validOverlay], knownAssets, knownPages);
    expect(errors).toHaveLength(0);
  });

  it('returns an error when assetId is unknown', () => {
    const overlay = { ...validOverlay, assetId: 'missing' };
    const errors = validateSignatureOverlays([overlay], knownAssets, knownPages);
    expect(errors.some((e) => e.includes('assetId'))).toBe(true);
  });

  it('returns an error when pageId is unknown', () => {
    const overlay = { ...validOverlay, pageId: 'missing' };
    const errors = validateSignatureOverlays([overlay], knownAssets, knownPages);
    expect(errors.some((e) => e.includes('pageId'))).toBe(true);
  });

  it('returns an error when x+width exceeds 100', () => {
    const overlay = { ...validOverlay, x: 90, width: 20 };
    const errors = validateSignatureOverlays([overlay], knownAssets, knownPages);
    expect(errors.some((e) => e.includes('width'))).toBe(true);
  });

  it('returns an error for invalid rotation', () => {
    const overlay = { ...validOverlay, rotation: 45 };
    const errors = validateSignatureOverlays([overlay], knownAssets, knownPages);
    expect(errors.some((e) => e.includes('rotation'))).toBe(true);
  });

  it('returns an error when overlay count exceeds the limit', () => {
    const overlays = Array.from({ length: MAX_SIGNATURE_OVERLAYS_PER_SESSION + 1 }, (_, i) => ({
      ...validOverlay,
      id: `ov-${i}`,
    }));
    const errors = validateSignatureOverlays(overlays, knownAssets, knownPages);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns an error for duplicate overlay ids', () => {
    const errors = validateSignatureOverlays(
      [validOverlay, { ...validOverlay, x: 50 }],
      knownAssets,
      knownPages
    );
    expect(errors.some((e) => e.includes('duplicate'))).toBe(true);
  });
});

// ── stripOrphanedOverlays ─────────────────────────────────────────────────────

describe('stripOrphanedOverlays', () => {
  it('removes placements whose assetId no longer exists', () => {
    const state: PdfSignatureState = {
      assets: [
        { assetId: 'a1', source: 'drawn', widthPx: 100, heightPx: 50, uploadedAt: '' },
      ],
      overlays: [
        { id: 'o1', pageId: 'p1', assetId: 'a1', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 1 },
        { id: 'o2', pageId: 'p1', assetId: 'a2', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 2 },
      ],
    };
    const cleaned = stripOrphanedOverlays(state);
    expect(cleaned.overlays).toHaveLength(1);
    expect(cleaned.overlays[0].assetId).toBe('a1');
  });

  it('returns the same reference when no orphans exist', () => {
    const state: PdfSignatureState = {
      assets: [{ assetId: 'a1', source: 'typed', widthPx: 100, heightPx: 50, uploadedAt: '' }],
      overlays: [
        { id: 'o1', pageId: 'p1', assetId: 'a1', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 1 },
      ],
    };
    expect(stripOrphanedOverlays(state)).toBe(state);
  });

  it('removes placements whose pageId no longer exists in the manifest', () => {
    const state: PdfSignatureState = {
      assets: [
        { assetId: 'a1', source: 'drawn', widthPx: 100, heightPx: 50, uploadedAt: '' },
      ],
      overlays: [
        { id: 'valid', pageId: 'current-page', assetId: 'a1', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 1 },
        { id: 'stale', pageId: 'removed-page', assetId: 'a1', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 2 },
      ],
    };
    const cleanForManifest = stripOrphanedOverlays as (
      value: PdfSignatureState,
      knownPageIds: Set<string>
    ) => PdfSignatureState;

    const cleaned = cleanForManifest(state, new Set(['current-page']));

    expect(cleaned.overlays.map((overlay) => overlay.id)).toEqual(['valid']);
  });
});

describe('pruneUnreferencedSignatureAssets', () => {
  it('removes old unreferenced assets while retaining referenced and recent assets', () => {
    const state: PdfSignatureState = {
      assets: [
        { assetId: 'referenced', source: 'drawn', widthPx: 100, heightPx: 50, uploadedAt: '2026-07-23T10:00:00.000Z' },
        { assetId: 'stale', source: 'uploaded', widthPx: 100, heightPx: 50, uploadedAt: '2026-07-23T09:00:00.000Z' },
        { assetId: 'recent', source: 'typed', widthPx: 100, heightPx: 50, uploadedAt: '2026-07-23T10:00:30.000Z' },
      ],
      overlays: [
        { id: 'overlay-1', pageId: 'page-1', assetId: 'referenced', x: 0, y: 0, width: 20, height: 10, rotation: 0, opacity: 100, zIndex: 1 },
      ],
    };
    const prune = (
      pdfSignatureService as unknown as {
        pruneUnreferencedSignatureAssets: (
          value: PdfSignatureState,
          retainUnreferencedSince?: number
        ) => PdfSignatureState;
      }
    ).pruneUnreferencedSignatureAssets;

    expect(prune).toBeDefined();
    const cleaned = prune(
      state,
      Date.parse('2026-07-23T10:00:00.000Z')
    );

    expect(cleaned.assets.map((asset) => asset.assetId)).toEqual([
      'referenced',
      'recent',
    ]);
  });
});
