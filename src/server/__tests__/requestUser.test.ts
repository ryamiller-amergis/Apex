import type { Request } from 'express';
import { getUserId, getDisplayName } from '../utils/requestUser';

function makeReq(user: unknown): Request {
  return { user } as unknown as Request;
}

// ── getUserId ─────────────────────────────────────────────────────────────────

describe('getUserId', () => {
  it('returns profile.oid when present (preferred stable identifier)', () => {
    const req = makeReq({ profile: { oid: 'abc-123', upn: 'user@example.com' }, accessToken: 'tok' });
    expect(getUserId(req)).toBe('abc-123');
  });

  it('falls back to profile.sub when oid is absent', () => {
    const req = makeReq({ profile: { sub: 'sub-456', upn: 'user@example.com' } });
    expect(getUserId(req)).toBe('sub-456');
  });

  it('falls back to profile.upn when oid and sub are absent', () => {
    const req = makeReq({ profile: { upn: 'user@example.com' } });
    expect(getUserId(req)).toBe('user@example.com');
  });

  it('returns "anonymous" when req.user is undefined', () => {
    const req = makeReq(undefined);
    expect(getUserId(req)).toBe('anonymous');
  });

  it('returns "anonymous" when profile is missing entirely', () => {
    const req = makeReq({ accessToken: 'tok' });
    expect(getUserId(req)).toBe('anonymous');
  });

  it('returns "anonymous" when profile has no identity fields', () => {
    const req = makeReq({ profile: { displayName: 'Alice' } });
    expect(getUserId(req)).toBe('anonymous');
  });

  it('does NOT read oid from the top-level user object (old bug path)', () => {
    // This is the exact shape that caused the bug — oid at the top level
    // rather than under profile. getUserId must NOT use this.
    const req = makeReq({ oid: 'top-level-oid', profile: { displayName: 'Bob' } });
    expect(getUserId(req)).toBe('anonymous');
  });
});

// ── getDisplayName ────────────────────────────────────────────────────────────

describe('getDisplayName', () => {
  it('returns profile.displayName when present', () => {
    const req = makeReq({ profile: { displayName: 'Alice Smith', upn: 'alice@example.com' } });
    expect(getDisplayName(req)).toBe('Alice Smith');
  });

  it('falls back to profile.upn when displayName is absent', () => {
    const req = makeReq({ profile: { upn: 'alice@example.com' } });
    expect(getDisplayName(req)).toBe('alice@example.com');
  });

  it('returns "Unknown User" when profile is missing', () => {
    const req = makeReq(undefined);
    expect(getDisplayName(req)).toBe('Unknown User');
  });

  it('returns "Unknown User" when profile has no name fields', () => {
    const req = makeReq({ profile: { oid: 'abc-123' } });
    expect(getDisplayName(req)).toBe('Unknown User');
  });
});
