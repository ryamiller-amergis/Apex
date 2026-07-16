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
      appUserProjectRoles: {
        findMany: jest.fn(),
      },
    },
  },
}));

import { getActiveUsers, listUsersForProject } from '../services/rbacService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

describe('listUsersForProject', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only assigned users with flattened role names and project roles', async () => {
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
    mockDb.query.appUserProjectRoles.findMany.mockResolvedValue([
      { userId: 'user-1', role: { name: 'viewer' } },
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
        projectRoles: ['viewer'],
      },
      {
        oid: 'user-2',
        displayName: 'Bob',
        email: 'bob@example.com',
        lastSeenAt: '2026-07-15T12:00:00Z',
        roles: ['member', 'viewer'],
        projectRoles: [],
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

describe('getActiveUsers project scoping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns active users assigned to the requested project', async () => {
    const assignmentWhere = jest.fn().mockResolvedValue([{ userId: 'user-1' }]);
    const assignmentFrom = jest.fn().mockReturnValue({ where: assignmentWhere });
    const orderBy = jest.fn().mockResolvedValue([
      { oid: 'user-1', displayName: 'Alice', email: 'alice@example.com' },
    ]);
    const activeWhere = jest.fn().mockReturnValue({ orderBy });
    const activeFrom = jest.fn().mockReturnValue({ where: activeWhere });
    mockDb.select
      .mockReturnValueOnce({ from: assignmentFrom })
      .mockReturnValueOnce({ from: activeFrom });

    const result = await getActiveUsers('Apex');

    expect(mockDb.select).toHaveBeenCalledTimes(2);
    expect(assignmentWhere).toHaveBeenCalledTimes(1);
    expect(activeWhere).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { oid: 'user-1', displayName: 'Alice', email: 'alice@example.com' },
    ]);
  });

  it('does not query active users when the project has no assigned users', async () => {
    const assignmentWhere = jest.fn().mockResolvedValue([]);
    const assignmentFrom = jest.fn().mockReturnValue({ where: assignmentWhere });
    mockDb.select.mockReturnValueOnce({ from: assignmentFrom });

    const result = await getActiveUsers('Empty Project');

    expect(result).toEqual([]);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});
