jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

import {
  assignUserToProject,
  bulkAssignUsersToProject,
  bulkSetProjectAssignments,
  getAllAssignments,
  getAssignmentsForProject,
  getAssignmentsForUser,
  groupAssignmentsByProject,
  listKnownApplicationUsers,
  removeUserFromProject,
} from '../services/userProjectAssignmentService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const assignmentRow = {
  id: 'assignment-1',
  userId: 'user-1',
  displayName: 'Alice Admin',
  email: 'alice@example.com',
  project: 'MaxView',
  assignedBy: 'super-admin',
  assignedAt: '2026-06-12T12:00:00Z',
};

describe('userProjectAssignmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getAssignmentsForUser', () => {
    it('returns ordered project names for a user', async () => {
      const orderByMock = jest.fn().mockResolvedValue([{ project: 'MatterWorx' }, { project: 'MaxView' }]);
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ where: whereMock });
      mockDb.select.mockReturnValue({ from: fromMock });

      const result = await getAssignmentsForUser('user-1');

      expect(result).toEqual(['MatterWorx', 'MaxView']);
      expect(whereMock).toHaveBeenCalledTimes(1);
      expect(orderByMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAssignmentsForProject', () => {
    it('returns assignments with user display fields', async () => {
      const orderByMock = jest.fn().mockResolvedValue([assignmentRow]);
      const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const innerJoinMock = jest.fn().mockReturnValue({ where: whereMock });
      const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
      mockDb.select.mockReturnValue({ from: fromMock });

      const result = await getAssignmentsForProject('MaxView');

      expect(result).toEqual([assignmentRow]);
      expect(innerJoinMock).toHaveBeenCalledTimes(1);
      expect(whereMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('listKnownApplicationUsers', () => {
    it('returns known application users ordered by display fields', async () => {
      const orderByMock = jest.fn().mockResolvedValue([
        { userId: 'user-1', displayName: 'Alice Admin', email: 'alice@example.com' },
        { userId: 'user-2', displayName: null, email: null },
      ]);
      const fromMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      mockDb.select.mockReturnValue({ from: fromMock });

      const result = await listKnownApplicationUsers();

      expect(result).toEqual([
        { userId: 'user-1', displayName: 'Alice Admin', email: 'alice@example.com' },
        { userId: 'user-2', displayName: '', email: '' },
      ]);
      expect(orderByMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAllAssignments', () => {
    it('returns all assignments ordered by project and user', async () => {
      const orderByMock = jest.fn().mockResolvedValue([assignmentRow]);
      const innerJoinMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
      mockDb.select.mockReturnValue({ from: fromMock });

      const result = await getAllAssignments();

      expect(result).toEqual([assignmentRow]);
      expect(orderByMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to user id and empty email when app user fields are null', async () => {
      const row = { ...assignmentRow, displayName: null, email: null };
      const orderByMock = jest.fn().mockResolvedValue([row]);
      const innerJoinMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
      const fromMock = jest.fn().mockReturnValue({ innerJoin: innerJoinMock });
      mockDb.select.mockReturnValue({ from: fromMock });

      const result = await getAllAssignments();

      expect(result[0]).toMatchObject({ displayName: 'user-1', email: '' });
    });
  });

  describe('assignUserToProject', () => {
    it('upserts one assignment', async () => {
      const onConflictMock = jest.fn().mockResolvedValue(undefined);
      const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
      mockDb.insert.mockReturnValue({ values: valuesMock });

      await assignUserToProject('user-1', 'MaxView', 'super-admin');

      expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'user-1',
        project: 'MaxView',
        assignedBy: 'super-admin',
      }));
      expect(onConflictMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('bulkAssignUsersToProject', () => {
    it('upserts de-duplicated non-empty users', async () => {
      const onConflictMock = jest.fn().mockResolvedValue(undefined);
      const valuesMock = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictMock });
      mockDb.insert.mockReturnValue({ values: valuesMock });

      await bulkAssignUsersToProject(['user-1', 'user-1', ' ', 'user-2'], 'MaxView', null);

      const values = valuesMock.mock.calls[0][0];
      expect(values).toHaveLength(2);
      expect(values.map((v: any) => v.userId)).toEqual(['user-1', 'user-2']);
      expect(onConflictMock).toHaveBeenCalledTimes(1);
    });

    it('does not insert when no valid user ids are supplied', async () => {
      await bulkAssignUsersToProject([], 'MaxView', 'super-admin');

      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('removeUserFromProject', () => {
    it('deletes the matching assignment', async () => {
      const whereMock = jest.fn().mockResolvedValue(undefined);
      mockDb.delete.mockReturnValue({ where: whereMock });

      await removeUserFromProject('user-1', 'MaxView');

      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(whereMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('bulkSetProjectAssignments', () => {
    it('replaces assignments for a project in a transaction', async () => {
      const txDeleteWhere = jest.fn().mockResolvedValue(undefined);
      const txValues = jest.fn().mockResolvedValue(undefined);
      const tx = {
        delete: jest.fn().mockReturnValue({ where: txDeleteWhere }),
        insert: jest.fn().mockReturnValue({ values: txValues }),
      };
      mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));

      await bulkSetProjectAssignments('MaxView', ['user-1', 'user-2'], 'super-admin');

      expect(tx.delete).toHaveBeenCalledTimes(1);
      expect(tx.insert).toHaveBeenCalledTimes(1);
      expect(txValues.mock.calls[0][0]).toHaveLength(2);
    });

    it('clears assignments without inserting when userIds is empty', async () => {
      const tx = {
        delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
        insert: jest.fn(),
      };
      mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));

      await bulkSetProjectAssignments('MaxView', [], 'super-admin');

      expect(tx.delete).toHaveBeenCalledTimes(1);
      expect(tx.insert).not.toHaveBeenCalled();
    });
  });

  describe('groupAssignmentsByProject', () => {
    it('groups assignments into project user lists', () => {
      const result = groupAssignmentsByProject([
        assignmentRow,
        { ...assignmentRow, id: 'assignment-2', userId: 'user-2', displayName: 'Bob', email: 'bob@example.com' },
      ]);

      expect(result).toEqual([
        {
          project: 'MaxView',
          users: [
            { userId: 'user-1', displayName: 'Alice Admin', email: 'alice@example.com' },
            { userId: 'user-2', displayName: 'Bob', email: 'bob@example.com' },
          ],
        },
      ]);
    });
  });
});
