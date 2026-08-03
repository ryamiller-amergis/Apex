/**
 * TBI-002 / PBI profile route integration tests (Supertest).
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import express from 'express';
import request from 'supertest';
import profileRouter from '../routes/profile';

jest.mock('../services/profileService', () => ({
  getCurrentProfile: jest.fn(),
  updateCurrentProfile: jest.fn(),
  getProfileCard: jest.fn(),
  ProfileValidationError: class ProfileValidationError extends Error {
    statusCode = 400;
    constructor(message: string) {
      super(message);
      this.name = 'ProfileValidationError';
    }
  },
  ProfileNotFoundError: class ProfileNotFoundError extends Error {
    statusCode = 404;
    constructor(message = 'User not found') {
      super(message);
      this.name = 'ProfileNotFoundError';
    }
  },
}));

jest.mock('../utils/requestUser', () => ({
  getDisplayName: () => 'Ada Lovelace',
  getUserEmail: () => 'ada@example.com',
}));

jest.mock('../services/graphOrgProfileService', () => ({
  fetchCurrentUserOrgProfile: jest.fn().mockResolvedValue(null),
}));

const profileService = jest.requireMock('../services/profileService') as {
  getCurrentProfile: jest.Mock;
  updateCurrentProfile: jest.Mock;
  getProfileCard: jest.Mock;
  ProfileValidationError: new (message: string) => Error;
  ProfileNotFoundError: new (message?: string) => Error;
};

const graphOrg = jest.requireMock('../services/graphOrgProfileService') as {
  fetchCurrentUserOrgProfile: jest.Mock;
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
      (req as AuthedRequest).user = {
        profile: {
          oid: 'oid-a',
          displayName: 'Ada Lovelace',
          upn: 'ada@example.com',
        },
      };
    }
    next();
  });
  app.use('/api/profile', profileRouter);
  return app;
}

describe('profile routes — TBI-002 DoD-0 DoD-1 DoD-3 / PBI-001', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    graphOrg.fetchCurrentUserOrgProfile.mockResolvedValue(null);
  });

  it('DoD-0: GET /current returns identity + bio (200)', async () => {
    profileService.getCurrentProfile.mockResolvedValue({
      userOid: 'oid-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      bio: 'Hello',
      avatar: { userOid: 'oid-a', version: null },
      updatedAt: '2026-07-28T00:00:00.000Z',
    });

    const res = await request(buildApp()).get('/api/profile/current');
    expect(res.status).toBe(200);
    expect(res.body.bio).toBe('Hello');
    expect(res.body.displayName).toBe('Ada Lovelace');
    expect(res.body.org).toBeNull();
    expect(profileService.getCurrentProfile).toHaveBeenCalledWith(
      'oid-a',
      expect.objectContaining({ displayName: 'Ada Lovelace', email: 'ada@example.com' })
    );
  });

  it('GET /current attaches Graph org fields when available', async () => {
    profileService.getCurrentProfile.mockResolvedValue({
      userOid: 'oid-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      bio: null,
      avatar: { userOid: 'oid-a', version: null },
      updatedAt: null,
    });
    graphOrg.fetchCurrentUserOrgProfile.mockResolvedValue({
      jobTitle: 'Engineer',
      department: 'Platform',
      officeLocation: null,
      companyName: null,
      manager: {
        userOid: 'oid-mgr',
        displayName: 'Boss',
        jobTitle: 'Manager',
        email: 'boss@example.com',
      },
      directReports: [],
    });

    const res = await request(buildApp()).get('/api/profile/current');
    expect(res.status).toBe(200);
    expect(res.body.org.jobTitle).toBe('Engineer');
    expect(res.body.org.manager.displayName).toBe('Boss');
  });

  it('DoD-1 / AC-2: PUT /current accepts empty and 500-char bio', async () => {
    profileService.updateCurrentProfile.mockResolvedValue({
      userOid: 'oid-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      bio: null,
      avatar: { userOid: 'oid-a', version: null },
      updatedAt: '2026-07-28T00:00:00.000Z',
    });

    const empty = await request(buildApp()).put('/api/profile/current').send({ bio: '' });
    expect(empty.status).toBe(200);

    const boundary = 'y'.repeat(500);
    profileService.updateCurrentProfile.mockResolvedValue({
      userOid: 'oid-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      bio: boundary,
      avatar: { userOid: 'oid-a', version: null },
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
    const ok = await request(buildApp()).put('/api/profile/current').send({ bio: boundary });
    expect(ok.status).toBe(200);
    expect(ok.body.bio).toBe(boundary);
  });

  it('DoD-1 / AC-3: PUT rejects oversized, HTML, and unknown fields (400)', async () => {
    const oversized = await request(buildApp())
      .put('/api/profile/current')
      .send({ bio: 'z'.repeat(501) });
    expect(oversized.status).toBe(400);
    expect(profileService.updateCurrentProfile).not.toHaveBeenCalled();

    const html = await request(buildApp())
      .put('/api/profile/current')
      .send({ bio: '<script>x</script>' });
    expect(html.status).toBe(400);

    const crossUser = await request(buildApp())
      .put('/api/profile/current')
      .send({ bio: 'ok', userOid: 'oid-b' });
    expect(crossUser.status).toBe(400);
  });

  it('DoD-3 / AC-3 / VT-08: missing session OID returns 401', async () => {
    const res = await request(buildApp('unauthenticated')).get('/api/profile/current');
    expect(res.status).toBe(401);

    const put = await request(buildApp('missing-oid'))
      .put('/api/profile/current')
      .send({ bio: 'x' });
    expect(put.status).toBe(401);
  });

  it('AC-1 / VT-02: PUT returns 500 without mutating contract on unexpected failure', async () => {
    profileService.updateCurrentProfile.mockRejectedValue(new Error('db down'));
    const res = await request(buildApp()).put('/api/profile/current').send({ bio: 'retry' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });
});

describe('profile routes — TBI-002 DoD-2 DoD-3 / PBI-002', () => {
  beforeEach(() => jest.clearAllMocks());

  it('DoD-2 / AC-0: GET card returns projection without private fields', async () => {
    profileService.getProfileCard.mockResolvedValue({
      userOid: 'oid-b',
      displayName: 'Colleague',
      bio: 'Bio text',
      avatar: { userOid: 'oid-b', version: '2026-07-10T00:00:00.000Z' },
    });

    const res = await request(buildApp()).get('/api/profile/users/oid-b/card');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      userOid: 'oid-b',
      displayName: 'Colleague',
      bio: 'Bio text',
      avatar: { userOid: 'oid-b', version: '2026-07-10T00:00:00.000Z' },
    });
    expect(res.body).not.toHaveProperty('email');
    expect(JSON.stringify(res.body)).not.toMatch(/blob/i);
  });

  it('DoD-2: GET card 404 for unknown user', async () => {
    const { ProfileNotFoundError } = profileService;
    profileService.getProfileCard.mockRejectedValue(new ProfileNotFoundError());
    const res = await request(buildApp()).get('/api/profile/users/missing/card');
    expect(res.status).toBe(404);
  });

  it('AC-3 / VT-08: unauthenticated card request returns 401', async () => {
    const res = await request(buildApp('unauthenticated')).get(
      '/api/profile/users/oid-b/card'
    );
    expect(res.status).toBe(401);
    expect(profileService.getProfileCard).not.toHaveBeenCalled();
  });
});
