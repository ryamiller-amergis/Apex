/**
 * FEAT-002 avatar route integration tests (Supertest).
 * Criterion ids in names for Requirements → Test Matrix traceability.
 * Kept separate from profileRoutes.test.ts so FEAT-001 route tests keep working.
 */
import express from 'express';
import request from 'supertest';
import profileRouter from '../routes/profile';

jest.mock('../services/avatarService', () => ({
  replaceOwnAvatar: jest.fn(),
  deleteOwnAvatar: jest.fn(),
  AvatarValidationError: class AvatarValidationError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 400) {
      super(message);
      this.name = 'AvatarValidationError';
      this.statusCode = statusCode;
    }
  },
  AvatarDependencyError: class AvatarDependencyError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 502) {
      super(message);
      this.name = 'AvatarDependencyError';
      this.statusCode = statusCode;
    }
  },
}));

jest.mock('../services/avatarResolverService', () => ({
  resolveAvatar: jest.fn(),
  buildAvatarCacheHeaders: (source: 'uploaded' | 'graph', cacheVersion: string) => ({
    'Cache-Control':
      source === 'uploaded'
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=300',
    ETag: `"${cacheVersion}"`,
  }),
}));

jest.mock('../services/profileService', () => ({
  getCurrentProfile: jest.fn(),
  updateCurrentProfile: jest.fn(),
  getProfileCard: jest.fn(),
  ProfileValidationError: class ProfileValidationError extends Error {
    statusCode = 400;
  },
  ProfileNotFoundError: class ProfileNotFoundError extends Error {
    statusCode = 404;
  },
}));

jest.mock('../utils/requestUser', () => ({
  getDisplayName: () => 'Ada Lovelace',
  getUserEmail: () => 'ada@example.com',
}));

const avatarService = jest.requireMock('../services/avatarService') as {
  replaceOwnAvatar: jest.Mock;
  deleteOwnAvatar: jest.Mock;
  AvatarValidationError: new (message: string, statusCode?: number) => Error;
  AvatarDependencyError: new (message: string, statusCode?: number) => Error;
};
const avatarResolverService = jest.requireMock('../services/avatarResolverService') as {
  resolveAvatar: jest.Mock;
};

type AuthMode = 'authenticated' | 'unauthenticated' | 'missing-oid';

type AuthedRequest = express.Request & {
  user?: { profile?: { oid?: string; displayName?: string; upn?: string } };
};

function buildApp(mode: AuthMode = 'authenticated') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (mode === 'unauthenticated') {
      (req as AuthedRequest).user = undefined;
    } else if (mode === 'missing-oid') {
      (req as AuthedRequest).user = { profile: { displayName: 'No Oid' } };
    } else {
      (req as AuthedRequest).user = { profile: { oid: 'oid-a', displayName: 'Ada Lovelace', upn: 'ada@example.com' } };
    }
    next();
  });
  app.use('/api/profile', profileRouter);
  return app;
}

describe('avatar routes — DoD-2 / VT-09 unauthenticated access', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-09: unauthenticated GET /avatar/:userOid returns 401', async () => {
    const res = await request(buildApp('unauthenticated')).get('/api/profile/avatar/oid-b');
    expect(res.status).toBe(401);
    expect(avatarResolverService.resolveAvatar).not.toHaveBeenCalled();
  });

  it('VT-09: unauthenticated POST /avatar returns 401 without invoking the service', async () => {
    const res = await request(buildApp('unauthenticated'))
      .post('/api/profile/avatar')
      .attach('avatar', Buffer.from('fake-bytes'), 'avatar.jpg');
    expect(res.status).toBe(401);
    expect(avatarService.replaceOwnAvatar).not.toHaveBeenCalled();
  });

  it('VT-09: unauthenticated DELETE /avatar returns 401', async () => {
    const res = await request(buildApp('unauthenticated')).delete('/api/profile/avatar');
    expect(res.status).toBe(401);
    expect(avatarService.deleteOwnAvatar).not.toHaveBeenCalled();
  });

  it('VT-09: missing-oid session returns 401 for all three routes', async () => {
    const app = buildApp('missing-oid');
    expect((await request(app).get('/api/profile/avatar/oid-b')).status).toBe(401);
    expect((await request(app).post('/api/profile/avatar')).status).toBe(401);
    expect((await request(app).delete('/api/profile/avatar')).status).toBe(401);
  });
});

describe('avatar routes — POST /avatar success and validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uploads bytes + crop, calls replaceOwnAvatar with only the caller oid, returns 200', async () => {
    avatarService.replaceOwnAvatar.mockResolvedValue({
      avatar: { source: 'uploaded', url: '/api/profile/avatar/oid-a?v=1', cacheVersion: '1', initials: null },
      cacheVersion: '1',
    });

    const res = await request(buildApp())
      .post('/api/profile/avatar')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }))
      .attach('avatar', Buffer.from('fake-bytes'), 'avatar.jpg');

    expect(res.status).toBe(200);
    expect(res.body.avatar.source).toBe('uploaded');
    expect(avatarService.replaceOwnAvatar).toHaveBeenCalledWith(
      'oid-a',
      expect.any(Buffer),
      { x: 0, y: 0, width: 1, height: 1 },
      'Ada Lovelace'
    );
  });

  it('VT-04: a fake target oid field in the body is ignored — mutation is always self-scoped', async () => {
    avatarService.replaceOwnAvatar.mockResolvedValue({
      avatar: { source: 'uploaded', url: '/api/profile/avatar/oid-a?v=1', cacheVersion: '1', initials: null },
      cacheVersion: '1',
    });

    await request(buildApp())
      .post('/api/profile/avatar')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }))
      .field('userOid', 'oid-attacker')
      .field('targetOid', 'oid-attacker')
      .attach('avatar', Buffer.from('fake-bytes'), 'avatar.jpg');

    expect(avatarService.replaceOwnAvatar).toHaveBeenCalledWith(
      'oid-a',
      expect.any(Buffer),
      expect.anything(),
      'Ada Lovelace'
    );
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(buildApp())
      .post('/api/profile/avatar')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }));
    expect(res.status).toBe(400);
    expect(avatarService.replaceOwnAvatar).not.toHaveBeenCalled();
  });

  it('VT-04: maps AvatarValidationError(415) from an unsupported/SVG-like file to 415', async () => {
    avatarService.replaceOwnAvatar.mockRejectedValue(
      new avatarService.AvatarValidationError('Unsupported image format; use JPEG, PNG, or WebP', 415)
    );

    const res = await request(buildApp())
      .post('/api/profile/avatar')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }))
      .attach('avatar', Buffer.from('<svg></svg>'), { filename: 'avatar.svg', contentType: 'image/svg+xml' });

    expect(res.status).toBe(415);
  });

  it('maps AvatarDependencyError to its status code', async () => {
    avatarService.replaceOwnAvatar.mockRejectedValue(
      new avatarService.AvatarDependencyError('Avatar storage is unavailable', 503)
    );

    const res = await request(buildApp())
      .post('/api/profile/avatar')
      .field('crop', JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }))
      .attach('avatar', Buffer.from('fake-bytes'), 'avatar.jpg');

    expect(res.status).toBe(503);
  });
});

describe('avatar routes — DELETE /avatar — VT-08 self-only', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-08: DELETE ignores any target-user field in the body — always deletes the caller', async () => {
    avatarService.deleteOwnAvatar.mockResolvedValue({
      avatar: { source: 'initials', url: null, cacheVersion: '0', initials: 'AL' },
      cacheVersion: '0',
    });

    const res = await request(buildApp())
      .delete('/api/profile/avatar')
      .send({ userOid: 'oid-attacker', targetOid: 'oid-attacker' });

    expect(res.status).toBe(200);
    expect(avatarService.deleteOwnAvatar).toHaveBeenCalledWith('oid-a', 'Ada Lovelace');
  });

  it('maps service errors to their status codes', async () => {
    avatarService.deleteOwnAvatar.mockRejectedValue(
      new avatarService.AvatarDependencyError('Failed to delete avatar', 503)
    );
    const res = await request(buildApp()).delete('/api/profile/avatar');
    expect(res.status).toBe(503);
  });
});

describe('avatar routes — GET /avatar/:userOid', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams bytes with image content-type, cache headers, ETag, and nosniff', async () => {
    avatarResolverService.resolveAvatar.mockResolvedValue({
      kind: 'bytes',
      source: 'uploaded',
      bytes: Buffer.from('webp-bytes'),
      contentType: 'image/webp',
      cacheVersion: '2026-07-28T00:00:00.000Z',
      etag: '2026-07-28T00:00:00.000Z',
    });

    const res = await request(buildApp()).get('/api/profile/avatar/oid-b');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/webp');
    expect(res.headers['cache-control']).toContain('private');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers.etag).toBe('"2026-07-28T00:00:00.000Z"');
    expect(Buffer.from(res.body)).toEqual(Buffer.from('webp-bytes'));
  });

  it('returns 204 with initials fallback headers when there is no avatar', async () => {
    avatarResolverService.resolveAvatar.mockResolvedValue({
      kind: 'initials',
      initials: 'AL',
      cacheVersion: '0',
    });

    const res = await request(buildApp()).get('/api/profile/avatar/oid-b');
    expect(res.status).toBe(204);
    expect(res.headers['x-avatar-fallback']).toBe('initials');
    expect(res.headers['x-avatar-initials']).toBe('AL');
  });

  it('maps AvatarDependencyError from the resolver to its status code', async () => {
    avatarResolverService.resolveAvatar.mockRejectedValue(
      new avatarService.AvatarDependencyError('Avatar storage is unavailable', 503)
    );
    const res = await request(buildApp()).get('/api/profile/avatar/oid-b');
    expect(res.status).toBe(503);
  });

  it('never leaks a Blob URL or the avatar_blob_key field in any response', async () => {
    avatarResolverService.resolveAvatar.mockResolvedValue({
      kind: 'initials',
      initials: 'AL',
      cacheVersion: '0',
    });
    const res = await request(buildApp()).get('/api/profile/avatar/oid-b');
    expect(JSON.stringify(res.headers)).not.toMatch(/blob\.core\.windows\.net/i);
    expect(JSON.stringify(res.headers)).not.toContain('avatar_blob_key');
  });
});
