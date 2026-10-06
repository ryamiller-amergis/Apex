jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(),
    query: {
      appRoles: {
        findFirst: jest.fn(),
      },
    },
  },
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

import {
  approveRfpSubmitAccessRequest,
  createRfpSubmitAccessRequest,
  listCurrentUserSubmitAccessRequests,
  rejectRfpSubmitAccessRequest,
  userHasRfpSubmitAccess,
} from '../services/rfpSubmitAccessRequestService';
import { getUserPermissions } from '../services/rbacService';
import { createNotification } from '../services/notificationService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockGetUserPermissions = getUserPermissions as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;

const pendingRequestRow = {
  id: 'request-1',
  userId: 'user-1',
  status: 'pending' as const,
  requestedAt: '2026-08-20T12:00:00Z',
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
};

function mockSelectLimit(rows: unknown[]) {
  const limitMock = jest.fn().mockResolvedValue(rows);
  const whereMock = jest.fn().mockReturnValue({ limit: limitMock, orderBy: jest.fn().mockResolvedValue(rows) });
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  mockDb.select.mockReturnValue({ from: fromMock });
  return { whereMock, limitMock };
}

describe('rfpSubmitAccessRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserPermissions.mockResolvedValue(new Set());
  });

  it('treats Apex or global rfp-intake:submit as already granted', async () => {
    mockGetUserPermissions
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(['rfp-intake:submit']));

    await expect(userHasRfpSubmitAccess('user-1')).resolves.toBe(true);
  });

  it('creates a pending request and notifies super admins', async () => {
    mockSelectLimit([]);
    const returningMock = jest.fn().mockResolvedValue([pendingRequestRow]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ displayName: 'Ada Lovelace', email: 'ada@example.com' }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockResolvedValue([{ oid: 'admin-1', email: 'ryamiller@amergis.com' }]),
      });

    const result = await createRfpSubmitAccessRequest('user-1');

    expect(result).toEqual(expect.objectContaining({ id: 'request-1', status: 'pending' }));
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        type: 'user-action',
        title: 'New Request for Product access request',
        link: '/platform-admin',
      }),
    );
  });

  it('returns the existing pending request instead of inserting another', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([pendingRequestRow]),
        }),
      }),
    });

    const result = await createRfpSubmitAccessRequest('user-1');

    expect(result?.id).toBe('request-1');
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('does not create a request when the user already has submit access', async () => {
    mockGetUserPermissions.mockResolvedValue(new Set(['rfp-intake:submit']));

    const result = await createRfpSubmitAccessRequest('user-1');

    expect(result).toBeNull();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('lists the current user requests newest first', async () => {
    const orderByMock = jest.fn().mockResolvedValue([pendingRequestRow]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereMock }) });

    const result = await listCurrentUserSubmitAccessRequests('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe('user-1');
  });

  it('approves by assigning rfp-submitter globally and as an Apex project role when Apex roles exist', async () => {
    mockDb.query.appRoles.findFirst.mockResolvedValue({ id: 'role-submitter', name: 'rfp-submitter' });
    const selectWhere = jest.fn().mockResolvedValue([pendingRequestRow]);
    const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
    const roleInsert = jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) });
    const projectRoleInsert = jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockResolvedValue(undefined) });
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: jest.fn()
        .mockReturnValueOnce({ from: jest.fn().mockReturnValue({ innerJoin }) })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ id: 'pr-1' }]) }),
          }),
        }),
      insert: jest.fn()
        .mockReturnValueOnce({ values: roleInsert })
        .mockReturnValueOnce({ values: projectRoleInsert }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    };
    mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await approveRfpSubmitAccessRequest('request-1', 'admin-oid');

    expect(result?.status).toBe('approved');
    expect(tx.insert).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'Request for Product access approved' }),
    );
  });

  it('rejects a pending request without assigning a role', async () => {
    const selectWhere = jest.fn().mockResolvedValue([pendingRequestRow]);
    const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
    const updateWhere = jest.fn().mockResolvedValue(undefined);
    const tx = {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ innerJoin }) }),
      insert: jest.fn(),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updateWhere }) }),
    };
    mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));

    const result = await rejectRfpSubmitAccessRequest('request-1', 'admin-oid');

    expect(result?.status).toBe('rejected');
    expect(tx.insert).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'Request for Product access declined' }),
    );
  });
});
