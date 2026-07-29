/**
 * FEAT-002 — Avatar image validation and normalization.
 *
 * Accepts only JPEG/PNG/WebP (verified via decoded sharp metadata, never
 * trusted from client-supplied MIME type), rejects empty/oversized/animated/
 * corrupt/decompression-bomb inputs, applies EXIF orientation and the
 * client-selected square crop, strips all metadata, and emits a fixed
 * 256x256 WebP suitable for storage.
 */
import sharp from 'sharp';
import {
  AVATAR_MAX_BYTES,
  AVATAR_OUTPUT_SIZE,
  type NormalizedAvatarCrop,
} from '../../shared/types/profile';

export class AvatarValidationError extends Error {
  readonly statusCode: 400 | 413 | 415;
  constructor(message: string, statusCode: 400 | 413 | 415 = 400) {
    super(message);
    this.name = 'AvatarValidationError';
    this.statusCode = statusCode;
  }
}

export class AvatarProcessingError extends Error {
  readonly statusCode = 500;
  constructor(message = 'Failed to process avatar image') {
    super(message);
    this.name = 'AvatarProcessingError';
  }
}

const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp']);

/** Decompression-bomb guard: cap decoded pixel count regardless of file size. */
const MAX_PIXELS = 25_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Validate, orient, crop, and resize an avatar upload into a 256x256 WebP.
 * Throws AvatarValidationError for any untrusted-input problem (mapped to
 * 400/413/415 by callers) and AvatarProcessingError for unexpected decode
 * failures during the transform pipeline itself.
 */
export async function processAvatarImage(
  buffer: Buffer,
  crop: NormalizedAvatarCrop
): Promise<Buffer> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AvatarValidationError('Avatar file is empty', 400);
  }
  if (buffer.length > AVATAR_MAX_BYTES) {
    throw new AvatarValidationError('Avatar file exceeds the maximum size', 413);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new AvatarValidationError('Avatar file could not be read', 415);
  }

  const format = metadata.format;
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    throw new AvatarValidationError('Unsupported image format; use JPEG, PNG, or WebP', 415);
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new AvatarValidationError('Animated images are not supported', 415);
  }

  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new AvatarValidationError('Avatar file could not be read', 415);
  }
  if (width * height > MAX_PIXELS) {
    throw new AvatarValidationError('Image resolution is too large', 415);
  }

  try {
    // Bake EXIF orientation into pixel data first so crop coordinates (which
    // the client computed against the visually-oriented preview) line up.
    const orientedBuffer = await sharp(buffer).rotate().toBuffer();
    const orientedMeta = await sharp(orientedBuffer).metadata();
    const orientedWidth = orientedMeta.width ?? width;
    const orientedHeight = orientedMeta.height ?? height;

    const left = clamp(Math.round(crop.x * orientedWidth), 0, orientedWidth - 1);
    const top = clamp(Math.round(crop.y * orientedHeight), 0, orientedHeight - 1);
    const cropWidth = clamp(Math.round(crop.width * orientedWidth), 1, orientedWidth - left);
    const cropHeight = clamp(Math.round(crop.height * orientedHeight), 1, orientedHeight - top);

    // No .withMetadata() call — sharp strips EXIF/ICC/XMP from the output by default.
    return await sharp(orientedBuffer)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (error) {
    if (error instanceof AvatarValidationError) {
      throw error;
    }
    throw new AvatarProcessingError();
  }
}
