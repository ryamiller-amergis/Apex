jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: jest.fn(),
}));

jest.mock('../services/projectCatalogService', () => ({
  listProjectCatalog: jest.fn(),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({ id: 'notif-1' }),
}));

jest.mock('../services/rfpProposalService', () => ({
  listIntakePrivateProjectNames: jest.fn().mockResolvedValue([]),
}));

import {
  approveProjectAccessRequest,
  createProjectAccessRequests,
  listRequestableProjectsForUser,
  rejectProjectAccessRequest,
} from '../services/projectAccessRequestService';
import { getAssignmentsForUser } from '../services/userProjectAssignmentService';
import { listProjectCatalog } from '../services/projectCatalogService';
import { createNotification } from '../services/notificationService';
import { listIntakePrivateProjectNames } from '../services/rfpProposalService';

const mockListIntakePrivate = listIntakePrivateProjectNames as jest.Mock;
const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const mockGetAssignmentsForUser = getAssignmentsForUser as jest.Mock;
const mockListProjectCatalog = listProjectCatalog as jest.Mock;
const mockCreateNotification = createNotification as jest.Mock;

const pendingRequestRow = {
  id: 'request-1',
  userId: 'user-1',
  project: 'MaxView',
  status: 'pending',
  requestedAt: '2026-06-12T12:00:00Z',
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
};

function mockSelectWhere(rows: unknown[]) {
  const whereMock = jest.fn().mockResolvedValue(rows);
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  mockDb.select.mockReturnValue({ from: fromMock });
  return { whereMock };
}

function mockInsertReturning(rows: unknown[]) {
  const returningMock = jest.fn().mockResolvedValue(rows);
  const onConflictDoNothingMock = jest.fn().mockReturnValue({ returning: returningMock });
  const valuesMock = jest.fn().mockReturnValue({ onConflictDoNothing: onConflictDoNothingMock });
  mockDb.insert.mockReturnValue({ values: valuesMock });
  return { valuesMock, onConflictDoNothingMock };
}

function createTx(requestRow = pendingRequestRow) {
  const selectWhere = jest.fn().mockResolvedValue(requestRow ? [requestRow] : []);
  const innerJoin = jest.fn().mockReturnValue({ where: selectWhere });
  const from = jest.fn().mockReturnValue({ innerJoin });
  const assignmentUpsert = jest.fn().mockResolvedValue(undefined);
  const insertValues = jest.fn().mockReturnValue({ onConflictDoUpdate: assignmentUpsert });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });
  const tx = {
    select: jest.fn().mockReturnValue({ from }),
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    update: jest.fn().mockReturnValue({ set: updateSet }),
  };
  mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));
  return { tx, insertValues, assignmentUpsert, updateSet };
}

describe('projectAccessRequestService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates requests for multiple unassigned projects and ignores duplicates in the payload', async () => {
    mockListProjectCatalog.mockResolvedValue([
      { id: '1', name: 'MaxView', description: '' },
      { id: '2', name: 'MatterWorx', description: '' },
      { id: '3', name: 'Existing', description: '' },
    ]);
    mockGetAssignmentsForUser.mockResolvedValue(['Existing']);
    mockDb.select
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ displayName: 'Ada Lovelace', email: 'ada@example.com' }]),
        }),
      })
      .mockReturnValueOnce({
        from: jest.fn().mockResolvedValue([
          { oid: 'admin-1', email: 'ryamiller@amergis.com' },
        ]),
      });
    mockInsertReturning([
      { ...pendingRequestRow, id: 'request-1', project: 'MaxView' },
      { ...pendingRequestRow, id: 'request-2', project: 'MatterWorx' },
    ]);

    const result = await createProjectAccessRequests('user-1', ['MaxView', 'maxview', 'MatterWorx', 'Existing']);

    expect(result.map((request) => request.project)).toEqual(['MaxView', 'MatterWorx']);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({
        type: 'user-action',
        title: 'New project access request',
        link: '/platform-admin',
      }),
    );
  });

  it('does not create duplicate pending requests', async () => {
    mockListProjectCatalog.mockResolvedValue([{ id: '1', name: 'MaxView', description: '' }]);
    mockGetAssignmentsForUser.mockResolvedValue([]);
    mockSelectWhere([{ project: 'MaxView' }]);

    const result = await createProjectAccessRequests('user-1', ['maxview']);

    expect(result).toEqual([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('filters requestable projects by existing assignments and pending requests', async () => {
    mockListProjectCatalog.mockResolvedValue([
      { id: '1', name: 'MaxView', description: '' },
      { id: '2', name: 'MatterWorx', description: '' },
      { id: '3', name: 'Apex', description: '' },
    ]);
    mockGetAssignmentsForUser.mockResolvedValue(['MatterWorx']);
    const orderByMock = jest.fn().mockResolvedValue([{ ...pendingRequestRow, project: 'Apex' }]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    const fromMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.select.mockReturnValue({ from: fromMock });

    const result = await listRequestableProjectsForUser('user-1');

    expect(result.map((project) => project.name)).toEqual(['MaxView']);
  });

  it('AR-6 omits intake-private projects from the requestable catalog', async () => {
    mockListProjectCatalog.mockResolvedValue([
      { id: '1', name: 'MaxView', description: '' },
      { id: '2', name: 'Benefits Tracker', description: '' },
    ]);
    mockListIntakePrivate.mockResolvedValueOnce(['benefits tracker']);
    mockGetAssignmentsForUser.mockResolvedValue([]);
    const orderByMock = jest.fn().mockResolvedValue([]);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    mockDb.select.mockReturnValue({ from: jest.fn().mockReturnValue({ where: whereMock }) });

    const result = await listRequestableProjectsForUser('user-1');

    expect(result.map((project) => project.name)).toEqual(['MaxView']);
  });

  it('AR-6 refuses access requests for intake-private projects', async () => {
    mockListProjectCatalog.mockResolvedValue([{ id: '2', name: 'Benefits Tracker', description: '' }]);
    mockListIntakePrivate.mockResolvedValueOnce(['Benefits Tracker']);
    mockGetAssignmentsForUser.mockResolvedValue([]);
    mockSelectWhere([]);

    const result = await createProjectAccessRequests('user-1', ['Benefits Tracker']);

    expect(result).toEqual([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('approves a pending request and creates a project assignment', async () => {
    const { tx, insertValues, assignmentUpsert, updateSet } = createTx();

    const result = await approveProjectAccessRequest('request-1', 'admin-1');

    expect(result).toMatchObject({ id: 'request-1', status: 'approved', project: 'MaxView' });
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      project: 'MaxView',
      assignedBy: 'admin-1',
    }));
    expect(assignmentUpsert).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved', reviewedBy: 'admin-1' }));
  });

  it('rejects a pending request without creating a project assignment', async () => {
    const { tx, updateSet } = createTx();

    const result = await rejectProjectAccessRequest('request-1', 'admin-1');

    expect(result).toMatchObject({ id: 'request-1', status: 'rejected', project: 'MaxView' });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected', reviewedBy: 'admin-1' }));
  });
});
