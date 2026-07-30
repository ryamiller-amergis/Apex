/**
 * graphOrgProfileService — best-effort Graph org snapshot for current user.
 */
import type { Request } from 'express';
import { fetchCurrentUserOrgProfile } from '../services/graphOrgProfileService';

jest.mock('../services/graphUserToken', () => ({
  getGraphTokenForUser: jest.fn(),
}));

const { getGraphTokenForUser } = jest.requireMock('../services/graphUserToken') as {
  getGraphTokenForUser: jest.Mock;
};

function makeReq(): Request {
  return {} as Request;
}

describe('fetchCurrentUserOrgProfile', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns null when no Graph token is available', async () => {
    getGraphTokenForUser.mockResolvedValue(null);
    await expect(fetchCurrentUserOrgProfile(makeReq())).resolves.toBeNull();
    expect(global.fetch).toBe(originalFetch);
  });

  it('maps /me, manager, and direct reports from Graph', async () => {
    getGraphTokenForUser.mockResolvedValue('graph-token');

    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'oid-me',
          displayName: 'Ada Lovelace',
          jobTitle: 'Software Engineer',
          department: 'Platform',
          officeLocation: 'Richmond',
          companyName: 'Amergis',
          mail: 'ada@example.com',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'oid-mgr',
          displayName: 'Charles Babbage',
          jobTitle: 'Engineering Manager',
          mail: 'charles@example.com',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: 'oid-r1',
              displayName: 'Grace Hopper',
              jobTitle: 'Developer',
              mail: 'grace@example.com',
            },
          ],
        }),
      }) as jest.Mock;

    const org = await fetchCurrentUserOrgProfile(makeReq());
    expect(org).toEqual({
      jobTitle: 'Software Engineer',
      department: 'Platform',
      officeLocation: 'Richmond',
      companyName: 'Amergis',
      manager: {
        userOid: 'oid-mgr',
        displayName: 'Charles Babbage',
        jobTitle: 'Engineering Manager',
        email: 'charles@example.com',
      },
      directReports: [
        {
          userOid: 'oid-r1',
          displayName: 'Grace Hopper',
          jobTitle: 'Developer',
          email: 'grace@example.com',
        },
      ],
    });
  });

  it('returns null when /me fails', async () => {
    getGraphTokenForUser.mockResolvedValue('graph-token');
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    }) as jest.Mock;

    await expect(fetchCurrentUserOrgProfile(makeReq())).resolves.toBeNull();
  });

  it('treats missing manager (404) as null without failing', async () => {
    getGraphTokenForUser.mockResolvedValue('graph-token');
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'oid-me',
          displayName: 'Ada',
          jobTitle: null,
          department: 'Eng',
          officeLocation: null,
          companyName: null,
          mail: 'ada@example.com',
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ value: [] }),
      }) as jest.Mock;

    const org = await fetchCurrentUserOrgProfile(makeReq());
    expect(org).toEqual({
      jobTitle: null,
      department: 'Eng',
      officeLocation: null,
      companyName: null,
      manager: null,
      directReports: [],
    });
  });
});
