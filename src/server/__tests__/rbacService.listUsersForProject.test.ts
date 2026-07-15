/**
 * Unit tests for project-scoped user listing.
 * The Drizzle db is mocked so no database connection is required.
 */

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    query: {
      appUsers: {
        findMany: jest.fn(),
      },
    },
  },
}));

import { listUsersForProject } from '../services/rbacService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

describe('listUsersForProject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only assigned users with flattened role names', async () => {
    const where = jest.fn().mockResolvedValue([
      { userId: 'user-1' },
      { userId: 'user-2' },
    ]);
    const from = jest.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from });
    mockDb.query.appUsers.findMany.mockResolvedValue([
      {
        oid: 'user-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        lastSeenAt: null,
        userRoles: [{ role: { name: 'admin' } }],
      },
      {
        oid: 'user-2',
        displayName: 'Bob',
        email: 'bob@example.com',
        lastSeenAt: '2026-07-15T12:00:00Z',
        userRoles: [{ role: { name: 'member' } }, { role: { name: 'viewer' } }],
      },
    ]);

    const result = await listUsersForProject('Apex');

    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(mockDb.query.appUsers.findMany).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        oid: 'user-1',
        displayName: 'Alice',
        email: 'alice@example.com',
        lastSeenAt: null,
        roles: ['admin'],
      },
      {
        oid: 'user-2',
        displayName: 'Bob',
        email: 'bob@example.com',
        lastSeenAt: '2026-07-15T12:00:00Z',
        roles: ['member', 'viewer'],
      },
    ]);
  });

  it('returns an empty array without loading users when the project has no assignments', async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from });

    const result = await listUsersForProject('Empty Project');

    expect(result).toEqual([]);
    expect(mockDb.query.appUsers.findMany).not.toHaveBeenCalled();
  });
});
