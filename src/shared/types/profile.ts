/**
 * Shared profile contracts for current-user profile and org-wide profile cards.
 * AvatarSubject never exposes Blob keys or public URLs (FEAT-002 resolves bytes).
 */

export interface AvatarSubject {
  userOid: string;
  /** Cache-busting version token (ISO timestamp of avatar_updated_at), or null when no upload. */
  version: string | null;
}

/** Directory person projection from Microsoft Graph (signed-in user context). */
export interface ProfileOrgPerson {
  userOid: string;
  displayName: string;
  jobTitle: string | null;
  email: string | null;
}

/**
 * Organization fields available via Graph User.Read for the signed-in user.
 * Populated on GET/PUT /api/profile/current when a Graph token is available.
 */
export interface CurrentProfileOrg {
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  companyName: string | null;
  manager: ProfileOrgPerson | null;
  /** Capped list of direct reports (see MAX_DIRECT_REPORTS_ON_PROFILE). */
  directReports: ProfileOrgPerson[];
}

/** Max direct reports returned on the current profile payload. */
export const MAX_DIRECT_REPORTS_ON_PROFILE = 12;

export interface CurrentProfileResponse {
  userOid: string;
  displayName: string;
  email: string;
  bio: string | null;
  avatar: AvatarSubject;
  updatedAt: string | null;
  /**
   * Microsoft Graph org snapshot for the signed-in user.
   * null when Graph is unavailable (dev mock, missing token, or Graph error).
   * Omitted only on older clients/fixtures — treat missing like null.
   */
  org?: CurrentProfileOrg | null;
}

export interface UpdateCurrentProfileRequest {
  bio: string | null;
}

export interface ProfileCardResponse {
  userOid: string;
  displayName: string;
  bio: string | null;
  avatar: AvatarSubject;
}

export interface ProfileApiError {
  error: string;
}

/** Maximum bio length in Unicode code points (matches live character counter). */
export const PROFILE_BIO_MAX_CODE_POINTS = 500;

/**
 * Count Unicode code points (user-visible characters), not UTF-16 code units.
 */
export function countBioCodePoints(value: string): number {
  return Array.from(value).length;
}

/**
 * True when the string contains control characters (C0/C1) other than tab.
 * Newlines and other controls are rejected for plain-text bio storage.
 */
export function containsDisallowedControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(value);
}

/**
 * Detect markup-like input (HTML tags / angle-bracket markup).
 */
export function containsMarkupLikeInput(value: string): boolean {
  return /<\s*\/?\s*[a-zA-Z!]/.test(value) || /&lt;\s*\/?\s*[a-zA-Z!]/.test(value);
}

export type BioNormalizationResult =
  | { ok: true; bio: string | null }
  | { ok: false; error: string };

/**
 * Normalize and validate a bio value per BR-004 and assumptions:
 * - whitespace-only → null
 * - otherwise trim, then enforce ≤500 Unicode code points
 * - reject HTML/markup-like input and control characters
 */
export function normalizeAndValidateBio(input: unknown): BioNormalizationResult {
  if (input === null) {
    return { ok: true, bio: null };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: 'Bio must be a string or null' };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: true, bio: null };
  }

  if (containsDisallowedControlChars(trimmed)) {
    return { ok: false, error: 'Bio must be plain text without control characters' };
  }
  if (containsMarkupLikeInput(trimmed)) {
    return { ok: false, error: 'Bio must be plain text without HTML or markup' };
  }
  if (countBioCodePoints(trimmed) > PROFILE_BIO_MAX_CODE_POINTS) {
    return {
      ok: false,
      error: `Bio must be at most ${PROFILE_BIO_MAX_CODE_POINTS} characters`,
    };
  }

  return { ok: true, bio: trimmed };
}

/**
 * Parse PUT /api/profile/current body. Accepts exactly `{ bio: string | null }`.
 * Unknown fields, identity fields, and target IDs fail validation.
 */
export function parseUpdateCurrentProfileRequest(
  body: unknown
): { ok: true; value: UpdateCurrentProfileRequest } | { ok: false; error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be an object' };
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'bio') {
    return {
      ok: false,
      error: 'Request must contain exactly the bio field',
    };
  }

  const normalized = normalizeAndValidateBio(record.bio);
  if (normalized.ok === false) {
    return { ok: false, error: normalized.error };
  }

  return { ok: true, value: { bio: normalized.bio } };
}

/**
 * Map persisted avatar_updated_at to a safe AvatarSubject (no blob key).
 */
export function toAvatarSubject(
  userOid: string,
  avatarUpdatedAt: string | null | undefined
): AvatarSubject {
  return {
    userOid,
    version: avatarUpdatedAt ?? null,
  };
}

// ── FEAT-002: Secure Avatar Storage & Resolution ──────────────────────────────

/** Maximum accepted avatar upload size in bytes (5 MiB). */
export const AVATAR_MAX_BYTES = 5_242_880;

/** Output dimensions (square, in px) for a processed avatar. */
export const AVATAR_OUTPUT_SIZE = 256;

/**
 * Client-selected crop region, normalized to the 0–1 range of the
 * (EXIF-oriented) source image. May be non-square in normalized space when
 * the source aspect ratio is not 1:1 — the client sends a square *pixel*
 * window (Facebook-style), which maps to unequal width/height fractions.
 * The resolver always emits a square output.
 */
export interface NormalizedAvatarCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolved avatar presentation contract returned by mutation endpoints.
 * Never carries a Blob key — only an opaque resolver URL plus cache token.
 */
export type AvatarDescriptor =
  | { source: 'uploaded' | 'graph'; url: string; cacheVersion: string; initials: null }
  | { source: 'initials'; url: null; cacheVersion: string; initials: string };

export interface AvatarMutationResponse {
  avatar: AvatarDescriptor;
  cacheVersion: string;
}

/**
 * Build the opaque, cache-busted resolver URL clients use to fetch avatar
 * bytes or the initials fallback via GET /api/profile/avatar/:userOid.
 */
export function buildAvatarResolverUrl(userOid: string, cacheVersion: string): string {
  return `/api/profile/avatar/${encodeURIComponent(userOid)}?v=${encodeURIComponent(cacheVersion)}`;
}

const CROP_TOLERANCE = 0.01;

/**
 * Validate an untrusted crop payload (from multipart form field `crop`).
 * Requires finite numeric fields within [0, 1], positive dimensions, and
 * bounds that stay inside the source image. Width/height need not match —
 * a square pixel crop on a non-square photo produces unequal fractions.
 */
export function parseNormalizedAvatarCrop(
  input: unknown
): { ok: true; value: NormalizedAvatarCrop } | { ok: false; error: string } {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Crop must be an object with x, y, width, height' };
  }

  const record = input as Record<string, unknown>;
  const fields: Array<keyof NormalizedAvatarCrop> = ['x', 'y', 'width', 'height'];
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `Crop.${field} must be a finite number` };
    }
  }

  const { x, y, width, height } = record as unknown as NormalizedAvatarCrop;

  if (x < 0 || y < 0 || width <= 0 || height <= 0) {
    return { ok: false, error: 'Crop values must be non-negative with positive dimensions' };
  }
  if (x > 1 || y > 1 || width > 1 || height > 1) {
    return { ok: false, error: 'Crop values must be within the normalized 0–1 range' };
  }
  if (x + width > 1 + CROP_TOLERANCE || y + height > 1 + CROP_TOLERANCE) {
    return { ok: false, error: 'Crop must stay within the image bounds' };
  }

  return { ok: true, value: { x, y, width, height } };
}

/**
 * Derive up to two uppercase initials from a display name for the
 * initials-fallback avatar. Two-or-more word names use the first letter of
 * the first and last word; single-word names use its first two letters.
 * Non-letter/number characters are stripped; blank input yields '?'.
 */
export function deriveInitials(displayName: string): string {
  const trimmed = typeof displayName === 'string' ? displayName.trim() : '';
  if (!trimmed) {
    return '?';
  }

  const sanitize = (part: string): string => part.replace(/[^\p{L}\p{N}]/gu, '');
  const parts = trimmed.split(/\s+/).filter(Boolean);

  if (parts.length === 1) {
    const letters = sanitize(parts[0]).slice(0, 2).toUpperCase();
    return letters || '?';
  }

  const first = sanitize(parts[0]).slice(0, 1);
  const last = sanitize(parts[parts.length - 1]).slice(0, 1);
  const letters = `${first}${last}`.toUpperCase();
  return letters || '?';
}
