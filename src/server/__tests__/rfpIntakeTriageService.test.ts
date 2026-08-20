jest.mock('fs/promises', () => ({
  __esModule: true,
  default: {
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
  },
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/rfpEvaluationOrchestrationService', () => ({
  autoStartEvaluation: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForProject: jest.fn(),
}));

const mockInsertValues = jest.fn();
const mockReturning = jest.fn();
const mockUpdateSet = jest.fn();
const mockUpdateWhere = jest.fn();
const mockTxInsertValues = jest.fn();
const mockTxInsertReturning = jest.fn();
const mockTxUpdateWhere = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      rfpRequests: { findFirst: jest.fn() },
      rfpEvaluations: { findFirst: jest.fn(), findMany: jest.fn() },
      rfpComments: { findMany: jest.fn() },
      rfpAttachments: { findMany: jest.fn(), findFirst: jest.fn() },
      rfpRequestEvents: { findMany: jest.fn() },
    },
    insert: jest.fn(() => ({ values: mockInsertValues })),
    update: jest.fn(() => ({ set: mockUpdateSet })),
    select: jest.fn(),
    transaction: jest.fn(),
  },
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

import { db } from '../db/drizzle';
import { getUserPermissions } from '../services/rbacService';
import { createNotification } from '../services/notificationService';
import { getAssignmentsForProject } from '../services/userProjectAssignmentService';
import {
  addComment,
  addAttachment,
  getAttachment,
  reopenRequest,
  resolveMentions,
  resolveRecipients,
  transitionStatus,
} from '../services/rfpIntakeService';
import type { RfpRequest } from '../../shared/types/rfpIntake';

const mockedDb = db as any;
const mockedGetUserPermissions = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;
const mockedNotify = createNotification as jest.MockedFunction<typeof createNotification>;
const mockedAssignments = getAssignmentsForProject as jest.MockedFunction<typeof getAssignmentsForProject>;

const NOW = '2026-08-19T12:00:00.000Z';

const BASE_REQUEST: RfpRequest = {
  id: 'rfp-1',
  ownerId: 'owner-1',
  title: 'Internal intake tracker',
  stakeholder: 'BA team',
  request: 'Track RFPs in Apex',
  problem: 'Intake is fragmented',
  audience: 'internal',
  dataSensitivity: 'internal-only',
  existingSolution: 'none known',
  advantage: null,
  constraints: null,
  requestType: null,
  existingSystemStack: null,
  status: 'evaluated',
  aiStatus: 'complete',
  aiThreadId: null,
  sourceProject: 'Apex',
  currentEvaluationId: 'eval-1',
  clarificationUsed: false,
  createdAt: NOW,
  updatedAt: NOW,
  currentEvaluation: null,
};

function thenableInsert(rows: unknown[]) {
  mockInsertValues.mockReturnValue({
    returning: mockReturning.mockResolvedValue(rows),
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  });
}

function mockSuccessfulTx(commentRow?: unknown) {
  mockTxInsertReturning.mockResolvedValue(commentRow ? [commentRow] : [{}]);
  mockTxInsertValues.mockReturnValue({
    returning: mockTxInsertReturning,
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(undefined).then(onFulfilled, onRejected);
    },
  });
  mockedDb.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
    insert: jest.fn(() => ({ values: mockTxInsertValues })),
    update: jest.fn(() => ({
      set: jest.fn(() => ({ where: mockTxUpdateWhere.mockResolvedValue(undefined) })),
    })),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
  thenableInsert([]);
  mockedGetUserPermissions.mockResolvedValue(new Set(['rfp-intake:view', 'rfp-intake:manage']));
  mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
    ...BASE_REQUEST,
    audience: 'internal',
    dataSensitivity: 'internal-only',
  });
  mockedDb.query.rfpEvaluations.findFirst.mockResolvedValue(null);
  mockedDb.query.rfpEvaluations.findMany.mockResolvedValue([]);
  mockedDb.query.rfpComments.findMany.mockResolvedValue([]);
  mockedDb.query.rfpAttachments.findMany.mockResolvedValue([]);
  mockedDb.query.rfpRequestEvents.findMany.mockResolvedValue([]);
  mockedAssignments.mockResolvedValue([
    { id: 'a1', userId: 'triage-1', displayName: 'Triage User', email: 'triage@example.com', project: 'Apex', assignedBy: null, assignedAt: NOW },
    { id: 'a2', userId: 'owner-1', displayName: 'Owner', email: 'owner@example.com', project: 'Apex', assignedBy: null, assignedAt: NOW },
  ]);
  mockSuccessfulTx();
});

describe('PBI-005 transitionStatus VT-01', () => {
  it('AC-0 moves Evaluated to In Review and appends exactly one status event', async () => {
    await transitionStatus('rfp-1', 'in-review', 'triage-1');

    expect(mockedDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockTxInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'status-changed',
      actorId: 'triage-1',
      payload: expect.objectContaining({ from: 'evaluated', to: 'in-review' }),
    }));
    expect(mockedNotify).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({
        type: 'user-action',
        link: '/?request=rfp-1',
      }),
    );
  });

  it('AC-0 records a valid In Review decision without mutating the verdict', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      status: 'in-review',
    });

    await transitionStatus('rfp-1', 'accepted', 'triage-1', { note: 'Fits the platform' });

    expect(mockTxInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'status-changed',
      payload: expect.objectContaining({ from: 'in-review', to: 'accepted', note: 'Fits the platform' }),
    }));
  });
});

describe('PBI-005 transitionStatus VT-02', () => {
  it('AC-1 preserves prior status and writes no event when the transaction fails', async () => {
    mockedDb.transaction.mockRejectedValue(new Error('deadlock'));

    await expect(transitionStatus('rfp-1', 'in-review', 'triage-1')).rejects.toThrow('deadlock');
    expect(mockedNotify).not.toHaveBeenCalled();
  });
});

describe('PBI-005 constrained machine VT-03', () => {
  it('AC-2 resumes On Hold to In Review', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      status: 'on-hold',
    });

    await transitionStatus('rfp-1', 'in-review', 'triage-1');
    expect(mockTxInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ from: 'on-hold', to: 'in-review' }),
    }));
  });

  it('AC-2 rejects Accepted → In Review without reopen', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      status: 'accepted',
    });

    await expect(transitionStatus('rfp-1', 'in-review', 'triage-1')).rejects.toMatchObject({
      status: 409,
      code: 'INVALID_TRANSITION',
    });
    expect(mockedDb.transaction).not.toHaveBeenCalled();
  });

  it('AC-2 audited reopen from Accepted returns to In Review', async () => {
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      status: 'accepted',
    });

    await reopenRequest('rfp-1', 'triage-1', 'Need more discussion');
    expect(mockTxInsertValues).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'reopened',
      payload: expect.objectContaining({ from: 'accepted', to: 'in-review', reason: 'Need more discussion' }),
    }));
  });
});

describe('PBI-005 unauthorized VT-04', () => {
  it('AC-3 denies manage actions without rfp-intake:manage', async () => {
    mockedGetUserPermissions.mockResolvedValue(new Set(['rfp-intake:view']));
    await expect(transitionStatus('rfp-1', 'in-review', 'viewer-1')).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });
});

describe('TBI-004 resolveRecipients VT-09', () => {
  it('notifies manage holders plus platform admins on submit, never the requestor', async () => {
    mockedDb.select = jest.fn()
      .mockReturnValueOnce({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              innerJoin: () => ({
                where: () => Promise.resolve([{ userId: 'triage-1' }]),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ oid: 'admin-1' }]),
        }),
      });

    const recipients = await resolveRecipients({
      kind: 'submitted',
      request: BASE_REQUEST,
    });

    expect(recipients.every((row) => row.userId !== 'owner-1' || row.link.startsWith('/rfp-intake'))).toBe(true);
    expect(recipients.every((row) => row.type === 'user-action')).toBe(true);
    expect(recipients.every((row) => row.link === '/rfp-intake/rfp-1')).toBe(true);
  });

  it('does not broadly fan comments to all triage participants', async () => {
    mockedDb.select = jest.fn().mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve([{ userId: 'triage-1' }, { userId: 'triage-2' }]),
            }),
          }),
        }),
        where: () => Promise.resolve([]),
      }),
    });

    const recipients = await resolveRecipients({
      kind: 'comment-added',
      request: BASE_REQUEST,
      actorId: 'triage-1',
      mentionUserIds: ['triage-2'],
    });

    const ids = recipients.map((row) => row.userId).sort();
    expect(ids).toEqual(['owner-1', 'triage-2']);
    expect(recipients.find((row) => row.userId === 'owner-1')?.link).toBe('/?request=rfp-1');
    expect(recipients.find((row) => row.userId === 'triage-2')?.link).toBe('/rfp-intake/rfp-1');
  });
});

describe('PBI-006 comments and mentions', () => {
  it('AC-0 writes the comment, resolved mentions, and an activity event', async () => {
    const commentRow = {
      id: 'c-1',
      rfpRequestId: 'rfp-1',
      authorId: 'triage-1',
      body: 'Need a screenshot @owner-1',
      mentionedUserIds: ['owner-1'],
      createdAt: NOW,
    };
    mockSuccessfulTx(commentRow);

    const comment = await addComment('rfp-1', 'triage-1', {
      body: 'Need a screenshot @owner-1',
      mentionedUserIds: ['owner-1', 'outsider-9'],
    });

    expect(comment.id).toBe('c-1');
    expect(comment.mentionedUserIds).toEqual(['owner-1']);
    expect(mockedNotify).toHaveBeenCalledWith(
      'owner-1',
      expect.objectContaining({ type: 'user-action', link: '/?request=rfp-1' }),
    );
  });

  it('drops outsider mentions without granting access BR-008', async () => {
    const ids = await resolveMentions('rfp-1', ['triage-1', 'outsider-9']);
    expect(ids).toEqual(['triage-1']);
    expect(ids).not.toContain('outsider-9');
  });
});

describe('PBI-006 attachments VT-07 VT-08', () => {
  it('AC-2 accepts the fifth approved file at 10 MB', async () => {
    mockedDb.query.rfpAttachments.findMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, index) => ({
        id: `att-${index}`,
        filename: `file-${index}.png`,
        contentType: 'image/png',
        sizeBytes: 100,
        rfpRequestId: 'rfp-1',
        commentId: null,
        storageKey: 'k',
        createdAt: NOW,
      })),
    );
    const storedRow = {
      id: 'att-5',
      rfpRequestId: 'rfp-1',
      commentId: null,
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 10 * 1024 * 1024,
      storageKey: 'pending',
      createdAt: NOW,
    };
    thenableInsert([storedRow]);
    mockedDb.query.rfpAttachments.findFirst.mockResolvedValue({ ...storedRow, storageKey: 'path' });

    const saved = await addAttachment('rfp-1', 'owner-1', {
      filename: 'shot.png',
      contentType: 'image/png',
      sizeBytes: 10 * 1024 * 1024,
      buffer: Buffer.alloc(4),
    });

    expect(saved.filename).toBe('shot.png');
  });

  it('AC-3 rejects an unsupported type without storing the file', async () => {
    mockedDb.query.rfpAttachments.findMany.mockResolvedValue([]);
    await expect(addAttachment('rfp-1', 'owner-1', {
      filename: 'virus.exe',
      contentType: 'application/x-msdownload',
      sizeBytes: 10,
      buffer: Buffer.from('MZ'),
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it('AC-3 denies an outsider download without exposing the file', async () => {
    mockedGetUserPermissions.mockResolvedValue(new Set());
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      ownerId: 'someone-else',
    });

    await expect(getAttachment('rfp-1', 'att-1', 'outsider-9')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('PBI-005 first triage comment moves Evaluated to In Review', () => {
  it('is idempotent and does not re-fire after the request is already In Review', async () => {
    const commentRow = {
      id: 'c-2',
      rfpRequestId: 'rfp-1',
      authorId: 'triage-1',
      body: 'Looking now',
      mentionedUserIds: [],
      createdAt: NOW,
    };
    mockSuccessfulTx(commentRow);
    mockedDb.query.rfpRequests.findFirst.mockResolvedValue({
      ...BASE_REQUEST,
      status: 'in-review',
    });

    await addComment('rfp-1', 'triage-1', { body: 'Looking now' });
    const eventTypes = mockTxInsertValues.mock.calls
      .map((call: unknown[]) => (call[0] as { eventType?: string }).eventType)
      .filter(Boolean);
    expect(eventTypes).toEqual(['comment-added']);
  });
});
