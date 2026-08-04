/**
 * FEAT-002 avatarProcessingService tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import sharp from 'sharp';
import { processAvatarImage } from '../services/avatarProcessingService';
import { AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIZE } from '../../shared/types/profile';

const FULL_FRAME_CROP = { x: 0, y: 0, width: 1, height: 1 };

async function makeJpeg(width = 300, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg()
    .toBuffer();
}

async function makePng(width = 300, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 40, g: 200, b: 40, alpha: 1 } } })
    .png()
    .toBuffer();
}

async function makeWebp(width = 300, height = 300): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 40, b: 200 } } })
    .webp()
    .toBuffer();
}

async function makeGif(): Promise<Buffer> {
  return sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .gif()
    .toBuffer();
}

/**
 * Pad a valid JPEG to an exact byte length using ignorable COM (0xFFFE)
 * marker segments inserted right after the SOI marker. Decoders skip
 * unknown/comment segments, so the image remains valid at the target size.
 */
function padJpegToExactSize(source: Buffer, targetBytes: number): Buffer {
  const totalPadding = targetBytes - source.length;
  if (totalPadding < 4) {
    throw new Error(`Cannot pad JPEG: need at least 4 bytes of padding, got ${totalPadding}`);
  }
  const MAX_DATA = 65533; // 2-byte length field max (65535) minus the field itself
  const OVERHEAD = 4; // 0xFF 0xFE + 2-byte length field
  const segmentCount = Math.max(1, Math.ceil(totalPadding / (OVERHEAD + MAX_DATA)));
  const dataBudget = totalPadding - OVERHEAD * segmentCount;
  if (dataBudget < 0 || dataBudget > MAX_DATA * segmentCount) {
    throw new Error('Unable to pad JPEG to the exact target size');
  }

  const segments: Buffer[] = [];
  let remainingData = dataBudget;
  for (let i = 0; i < segmentCount; i += 1) {
    const isLast = i === segmentCount - 1;
    const dataLen = isLast ? remainingData : Math.min(MAX_DATA, remainingData);
    remainingData -= dataLen;
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = 0xfe;
    header.writeUInt16BE(dataLen + 2, 2);
    segments.push(Buffer.concat([header, Buffer.alloc(dataLen, 0)]));
  }

  return Buffer.concat([source.subarray(0, 2), ...segments, source.subarray(2)]);
}

describe('avatarProcessingService — DoD-0 / AC-2 accept jpeg/png/webp', () => {
  it('AC-2: accepts a JPEG and emits a 256x256 WebP with metadata stripped', async () => {
    const input = await makeJpeg();
    const output = await processAvatarImage(input, FULL_FRAME_CROP);
    const outMeta = await sharp(output).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.exif).toBeUndefined();
  });

  it('AC-2: accepts a PNG and emits a 256x256 WebP', async () => {
    const input = await makePng();
    const output = await processAvatarImage(input, FULL_FRAME_CROP);
    const outMeta = await sharp(output).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
  });

  it('AC-2: accepts a WebP source and emits a 256x256 WebP', async () => {
    const input = await makeWebp();
    const output = await processAvatarImage(input, FULL_FRAME_CROP);
    const outMeta = await sharp(output).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
  });

  it('DoD-0: applies a non-centered normalized crop before resizing to 256x256', async () => {
    const input = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    const output = await processAvatarImage(input, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    const outMeta = await sharp(output).metadata();
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
  });
});

describe('avatarProcessingService — VT-01 size boundaries', () => {
  it('VT-01: rejects an empty buffer', async () => {
    await expect(processAvatarImage(Buffer.alloc(0), FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 400,
    });
  });

  it('VT-01: rejects a buffer larger than AVATAR_MAX_BYTES (413)', async () => {
    const oversized = Buffer.alloc(AVATAR_MAX_BYTES + 1, 1);
    await expect(processAvatarImage(oversized, FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 413,
    });
  });

  it('VT-01: accepts a real image padded to exactly AVATAR_MAX_BYTES', async () => {
    const base = await makeJpeg(64, 64);
    const padded = padJpegToExactSize(base, AVATAR_MAX_BYTES);
    expect(padded.length).toBe(AVATAR_MAX_BYTES);

    const output = await processAvatarImage(padded, FULL_FRAME_CROP);
    const outMeta = await sharp(output).metadata();
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
  }, 20000);
});

describe('avatarProcessingService — VT-03 / VT-04 format rejection', () => {
  it('VT-04: rejects GIF images', async () => {
    const gif = await makeGif();
    await expect(processAvatarImage(gif, FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 415,
    });
  });

  it('VT-04: rejects SVG images (never trusts client MIME, verifies decoded format)', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>'
    );
    await expect(processAvatarImage(svg, FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 415,
    });
  });

  it('VT-03: rejects corrupt / unreadable image data', async () => {
    const corrupt = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    await expect(processAvatarImage(corrupt, FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 415,
    });
  });

  it('VT-04: rejects images exceeding the decompression-bomb pixel cap', async () => {
    const huge = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    await expect(processAvatarImage(huge, FULL_FRAME_CROP)).rejects.toMatchObject({
      name: 'AvatarValidationError',
      statusCode: 415,
    });
  }, 20000);
});

describe('avatarProcessingService — robustness against boundary crop values', () => {
  it('clamps a crop pinned to the far edge instead of throwing', async () => {
    const input = await makeJpeg(10, 10);
    const output = await processAvatarImage(input, { x: 0.99, y: 0.99, width: 1, height: 1 });
    const outMeta = await sharp(output).metadata();
    expect(outMeta.format).toBe('webp');
    expect(outMeta.width).toBe(AVATAR_OUTPUT_SIZE);
    expect(outMeta.height).toBe(AVATAR_OUTPUT_SIZE);
  });
});
