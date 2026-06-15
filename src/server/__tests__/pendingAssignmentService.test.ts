jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  assignUserToProject: jest.fn(),
}));

import {
  addPendingAssignments,
  listPendingForProject,
  removePendingAssignment,
  resolvePendingAssignments,
} from '../services/pendingAssignmentService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { assignUserToProject } = jest.requireMock('../services/userProjectAssignmentService') as {
  assignUserToProject: jest.Mock;
};

describe('pendingAssignmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('adds normalized pending assignments with assigned-by metadata', async () => {
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoNothing });
    mockDb.insert.mockReturnValue({ values });

    await addPendingAssignments(
      [{ email: ' Missing@Example.COM ', project: 'MaxView' }],
      'super-admin',
    );

    expect(values).toHaveBeenCalledWith([
      expect.objectContaining({
        email: 'missing@example.com',
        project: 'MaxView',
        assignedBy: 'super-admin',
      }),
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('does not insert when no pending assignments are supplied', async () => {
    await addPendingAssignments([], 'super-admin');

    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('resolves pending assignments into user-project assignments and deletes the pending rows', async () => {
    const where = jest.fn().mockResolvedValue([
      { id: 'pending-1', project: 'MaxView', assignedBy: 'super-admin' },
      { id: 'pending-2', project: 'MatterWorx', assignedBy: null },
    ]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    const deleteWhere = jest.fn().mockResolvedValue(undefined);
    const txDelete = jest.fn().mockReturnValue({ where: deleteWhere });
    const tx = { select, delete: txDelete };
    mockDb.transaction.mockImplementation(async (callback: (txArg: typeof tx) => Promise<void>) => callback(tx));

    await resolvePendingAssignments('user-1', 'MISSING@example.com');

    expect(assignUserToProject).toHaveBeenCalledWith('user-1', 'MaxView', 'super-admin');
    expect(assignUserToProject).toHaveBeenCalledWith('user-1', 'MatterWorx', null);
    expect(txDelete).toHaveBeenCalledTimes(1);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('skips resolution when oid or email is missing', async () => {
    await resolvePendingAssignments('', 'missing@example.com');
    await resolvePendingAssignments('user-1', '');

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('lists pending assignments for a project', async () => {
    const row = {
      id: 'pending-1',
      email: 'missing@example.com',
      project: 'MaxView',
      assignedBy: 'super-admin',
      assignedAt: '2026-06-14T12:00:00Z',
    };
    const where = jest.fn().mockResolvedValue([row]);
    const from = jest.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from });

    await expect(listPendingForProject('MaxView')).resolves.toEqual([row]);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('removes a pending assignment by project and email', async () => {
    const where = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where });

    await removePendingAssignment('Missing@Example.COM', 'MaxView');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });
});
