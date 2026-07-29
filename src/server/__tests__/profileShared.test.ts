/**
 * TBI-001 / shared contract tests — DoD-2 schema mapping helpers + bio validation.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import {
  PROFILE_BIO_MAX_CODE_POINTS,
  buildAvatarResolverUrl,
  countBioCodePoints,
  deriveInitials,
  normalizeAndValidateBio,
  parseNormalizedAvatarCrop,
  parseUpdateCurrentProfileRequest,
  toAvatarSubject,
} from '../../shared/types/profile';
import { userProfiles } from '../db/schema';

describe('TBI-001 DoD-1 — userProfiles Drizzle schema', () => {
  it('DoD-1: exposes typed user_profiles columns', () => {
    expect(userProfiles.userOid.name).toBe('user_oid');
    expect(userProfiles.bio.name).toBe('bio');
    expect(userProfiles.avatarBlobKey.name).toBe('avatar_blob_key');
    expect(userProfiles.avatarUpdatedAt.name).toBe('avatar_updated_at');
    expect(userProfiles.createdAt.name).toBe('created_at');
    expect(userProfiles.updatedAt.name).toBe('updated_at');
  });
});

describe('TBI-001 DoD-2 — schema mapping helpers', () => {
  it('DoD-2: toAvatarSubject maps version without exposing blob keys', () => {
    const subject = toAvatarSubject('oid-1', '2026-07-28T12:00:00.000Z');
    expect(subject).toEqual({
      userOid: 'oid-1',
      version: '2026-07-28T12:00:00.000Z',
    });
    expect(Object.keys(subject)).toEqual(['userOid', 'version']);
  });

  it('DoD-2: toAvatarSubject uses null version when no upload timestamp', () => {
    expect(toAvatarSubject('oid-2', null)).toEqual({ userOid: 'oid-2', version: null });
    expect(toAvatarSubject('oid-2', undefined)).toEqual({ userOid: 'oid-2', version: null });
  });
});

describe('Bio validation — BR-004 / VT-03 / VT-04', () => {
  it('AC-2 / VT-03: empty and whitespace-only bios normalize to null', () => {
    expect(normalizeAndValidateBio('')).toEqual({ ok: true, bio: null });
    expect(normalizeAndValidateBio('   ')).toEqual({ ok: true, bio: null });
    expect(normalizeAndValidateBio(null)).toEqual({ ok: true, bio: null });
  });

  it('AC-2 / VT-03: exactly 500 Unicode code points are accepted', () => {
    const bio = 'あ'.repeat(PROFILE_BIO_MAX_CODE_POINTS);
    expect(countBioCodePoints(bio)).toBe(500);
    expect(normalizeAndValidateBio(bio)).toEqual({ ok: true, bio });
  });

  it('AC-3 / VT-04: 501 code points are rejected', () => {
    const bio = 'x'.repeat(501);
    const result = normalizeAndValidateBio(bio);
    expect(result.ok).toBe(false);
  });

  it('AC-3 / VT-04: astral Unicode counts as one visible character', () => {
    // 😀 is one code point but two UTF-16 code units
    const emoji = '😀';
    expect(emoji.length).toBe(2);
    expect(countBioCodePoints(emoji)).toBe(1);
    const bio = emoji.repeat(500);
    expect(normalizeAndValidateBio(bio)).toEqual({ ok: true, bio });
  });

  it('AC-3 / VT-04: HTML / markup-like bio is rejected', () => {
    expect(normalizeAndValidateBio('<script>alert(1)</script>').ok).toBe(false);
    expect(normalizeAndValidateBio('Hello <b>world</b>').ok).toBe(false);
  });

  it('AC-3 / VT-04: control characters are rejected', () => {
    expect(normalizeAndValidateBio('hello\u0000world').ok).toBe(false);
  });

  it('trims leading and trailing whitespace before length check', () => {
    const inner = 'trimmed bio';
    expect(normalizeAndValidateBio(`  ${inner}  `)).toEqual({ ok: true, bio: inner });
  });
});

describe('parseUpdateCurrentProfileRequest — AC-3 cross-user / unknown fields', () => {
  it('AC-3: accepts exactly { bio }', () => {
    expect(parseUpdateCurrentProfileRequest({ bio: 'Hello' })).toEqual({
      ok: true,
      value: { bio: 'Hello' },
    });
  });

  it('AC-3: rejects unknown fields and identity / target fields', () => {
    expect(parseUpdateCurrentProfileRequest({ bio: 'x', userOid: 'other' }).ok).toBe(false);
    expect(parseUpdateCurrentProfileRequest({ bio: 'x', displayName: 'Nope' }).ok).toBe(false);
    expect(parseUpdateCurrentProfileRequest({ bio: 'x', email: 'a@b.c' }).ok).toBe(false);
    expect(parseUpdateCurrentProfileRequest({ targetOid: 'other', bio: 'x' }).ok).toBe(false);
    expect(parseUpdateCurrentProfileRequest({}).ok).toBe(false);
  });
});

describe('FEAT-002 buildAvatarResolverUrl — never carries a Blob key', () => {
  it('DoD-1: builds an opaque, cache-busted resolver URL', () => {
    const url = buildAvatarResolverUrl('oid-a', '2026-07-28T12:00:00.000Z');
    expect(url).toBe('/api/profile/avatar/oid-a?v=2026-07-28T12%3A00%3A00.000Z');
    expect(url).not.toMatch(/blob/i);
  });

  it('DoD-1: encodes special characters in oid and cacheVersion', () => {
    const url = buildAvatarResolverUrl('oid a/b', 'v 1');
    expect(url).toBe('/api/profile/avatar/oid%20a%2Fb?v=v%201');
  });
});

describe('FEAT-002 parseNormalizedAvatarCrop — AC-2 / VT-03 / VT-04', () => {
  it('AC-2: accepts a valid centered square crop', () => {
    const result = parseNormalizedAvatarCrop({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    expect(result).toEqual({ ok: true, value: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } });
  });

  it('AC-2: accepts a full-frame crop (0,0,1,1)', () => {
    expect(parseNormalizedAvatarCrop({ x: 0, y: 0, width: 1, height: 1 }).ok).toBe(true);
  });

  it('AC-2: accepts a landscape square-pixel crop (unequal normalized width/height)', () => {
    const result = parseNormalizedAvatarCrop({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(result).toEqual({ ok: true, value: { x: 0.25, y: 0, width: 0.5, height: 1 } });
  });

  it('AC-2: tolerates tiny floating point drift on bounds', () => {
    const result = parseNormalizedAvatarCrop({ x: 0, y: 0, width: 0.5, height: 0.505 });
    expect(result.ok).toBe(true);
  });

  it('VT-03: rejects non-object / missing input', () => {
    expect(parseNormalizedAvatarCrop(null).ok).toBe(false);
    expect(parseNormalizedAvatarCrop(undefined).ok).toBe(false);
    expect(parseNormalizedAvatarCrop('not-an-object').ok).toBe(false);
    expect(parseNormalizedAvatarCrop([0, 0, 1, 1]).ok).toBe(false);
  });

  it('VT-03: rejects missing or non-numeric fields', () => {
    expect(parseNormalizedAvatarCrop({ x: 0, y: 0, width: 1 }).ok).toBe(false);
    expect(parseNormalizedAvatarCrop({ x: '0', y: 0, width: 1, height: 1 }).ok).toBe(false);
    expect(parseNormalizedAvatarCrop({ x: 0, y: 0, width: NaN, height: 1 }).ok).toBe(false);
  });

  it('VT-04: rejects out-of-range crops', () => {
    expect(parseNormalizedAvatarCrop({ x: -0.1, y: 0, width: 0.5, height: 0.5 }).ok).toBe(false);
    expect(parseNormalizedAvatarCrop({ x: 0.9, y: 0, width: 0.5, height: 0.5 }).ok).toBe(false);
    expect(parseNormalizedAvatarCrop({ x: 0, y: 0, width: 0, height: 0 }).ok).toBe(false);
  });
});

describe('FEAT-002 deriveInitials — up to 2 sanitized letters', () => {
  it('AC-3: two-word names use first letter of first and last word', () => {
    expect(deriveInitials('Ada Lovelace')).toBe('AL');
    expect(deriveInitials('  Grace   Beatrice Hopper  ')).toBe('GH');
  });

  it('AC-3: single-word names use the first two letters', () => {
    expect(deriveInitials('Cher')).toBe('CH');
    expect(deriveInitials('X')).toBe('X');
  });

  it('AC-3: sanitizes punctuation and casing', () => {
    expect(deriveInitials("d'Angelo Russo")).toBe('DR');
    expect(deriveInitials('ada lovelace')).toBe('AL');
  });

  it('VT-04: blank or non-string input falls back to a safe placeholder', () => {
    expect(deriveInitials('')).toBe('?');
    expect(deriveInitials('   ')).toBe('?');
    expect(deriveInitials(undefined as unknown as string)).toBe('?');
    expect(deriveInitials('!!!')).toBe('?');
  });
});
