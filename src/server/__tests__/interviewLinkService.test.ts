/**
 * Unit tests for interviewLinkService (FEAT-001).
 * Covers VT-02, VT-04, VT-07 and related AC/DoD domain rules.
 */

const mockGetAssignmentsForUser = jest.fn();

jest.mock('../services/userProjectAssignmentService', () => ({
  getAssignmentsForUser: (...args: unknown[]) => mockGetAssignmentsForUser(...args),
}));

const mockInterviewFindFirst = jest.fn();
const mockAdrFindFirst = jest.fn();
const mockDesignModuleFindFirst = jest.fn();
const mockAdrLinksFindMany = jest.fn();
const mockModuleLinksFindMany = jest.fn();
const mockSelect = jest.fn();
const mockInsert = jest.fn();
const mockDelete = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      interviews: { findFirst: (...a: unknown[]) => mockInterviewFindFirst(...a) },
      adrs: { findFirst: (...a: unknown[]) => mockAdrFindFirst(...a) },
      designModules: { findFirst: (...a: unknown[]) => mockDesignModuleFindFirst(...a) },
      interviewAdrLinks: { findMany: (...a: unknown[]) => mockAdrLinksFindMany(...a) },
      interviewDesignModuleLinks: { findMany: (...a: unknown[]) => mockModuleLinksFindMany(...a) },
    },
    select: (...a: unknown[]) => mockSelect(...a),
    insert: (...a: unknown[]) => mockInsert(...a),
    delete: (...a: unknown[]) => mockDelete(...a),
    execute: (...a: unknown[]) => mockExecute(...a),
    transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

import {
  addAdrLink,
  addDesignModuleLink,
  getLinkedContext,
  removeAdrLink,
} from '../services/interviewLinkService';
import { InterviewLinkError, LINKED_CONTEXT_CAPACITY } from '../../shared/types/interviewLinks';

const ACTOR = { userId: 'user-ba', isSuperAdmin: true };
const INTERVIEW_ID = '11111111-1111-1111-1111-111111111111';
const ADR_ID = '22222222-2222-2222-2222-222222222222';
const MODULE_ID = '33333333-3333-3333-3333-333333333333';

function countChain(value: number) {
  return {
    from: () => ({
      where: () => Promise.resolve([{ value }]),
    }),
  };
}

function setupTransaction(opts: {
  interview?: { id: string; project: string; status: string } | null;
  adr?: { id: string; project: string; status: string } | null;
  designModule?: { id: string; project: string; label: string } | null;
  adrCount?: number;
  moduleCount?: number;
  insertError?: unknown;
  deleteReturning?: { id: string }[];
}) {
  const interview = opts.interview === undefined
    ? { id: INTERVIEW_ID, project: 'Apex', status: 'in_progress' }
    : opts.interview;

  mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      execute: jest.fn().mockResolvedValue({ rows: interview ? [interview] : [] }),
      query: {
        adrs: {
          findFirst: jest.fn().mockResolvedValue(
            opts.adr === undefined
              ? { id: ADR_ID, project: 'Apex', status: 'accepted' }
              : opts.adr,
          ),
        },
        designModules: {
          findFirst: jest.fn().mockResolvedValue(
            opts.designModule === undefined
              ? { id: MODULE_ID, project: 'Apex', label: 'Chat' }
              : opts.designModule,
          ),
        },
      },
      select: jest.fn()
        .mockImplementationOnce(() => countChain(opts.adrCount ?? 0))
        .mockImplementation(() => countChain(opts.moduleCount ?? 0)),
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation(async () => {
          if (opts.insertError) throw opts.insertError;
          return undefined;
        }),
      }),
      delete: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(opts.deleteReturning ?? [{ id: 'link-1' }]),
        }),
      }),
    };
    return fn(tx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAssignmentsForUser.mockResolvedValue(['Apex']);
  mockAdrLinksFindMany.mockResolvedValue([]);
  mockModuleLinksFindMany.mockResolvedValue([]);
});

describe('interviewLinkService — getLinkedContext (PBI-002 / VT-07)', () => {
  it('VT-07 / AC-2: keeps superseded ADR link present with isAccepted=false and staleReason', async () => {
    mockInterviewFindFirst.mockResolvedValue({
      id: INTERVIEW_ID,
      project: 'Apex',
      status: 'in_progress',
    });
    mockAdrLinksFindMany.mockResolvedValue([
      {
        adrId: ADR_ID,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-01T00:00:00.000Z',
        adr: { title: 'Async Infra', status: 'superseded' },
      },
    ]);
    mockModuleLinksFindMany.mockResolvedValue([]);

    const model = await getLinkedContext(INTERVIEW_ID, ACTOR);

    expect(model.count).toBe(1);
    expect(model.adrLinks).toHaveLength(1);
    expect(model.adrLinks[0]).toMatchObject({
      adrId: ADR_ID,
      title: 'Async Infra',
      isAccepted: false,
      staleReason: 'no_longer_accepted',
    });
  });

  it('VT-05 / AC-0: marks accepted ADR links as active', async () => {
    mockInterviewFindFirst.mockResolvedValue({
      id: INTERVIEW_ID,
      project: 'Apex',
      status: 'in_progress',
    });
    mockAdrLinksFindMany.mockResolvedValue([
      {
        adrId: ADR_ID,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-01T00:00:00.000Z',
        adr: { title: 'Async Infra', status: 'accepted' },
      },
    ]);
    mockModuleLinksFindMany.mockResolvedValue([
      {
        designModuleId: MODULE_ID,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-01T00:00:00.000Z',
        designModule: { label: 'Interview' },
      },
    ]);

    const model = await getLinkedContext(INTERVIEW_ID, ACTOR);
    expect(model.adrLinks[0].isAccepted).toBe(true);
    expect(model.adrLinks[0].staleReason).toBeUndefined();
    expect(model.designModuleLinks[0].name).toBe('Interview');
    expect(model.count).toBe(2);
    expect(model.capacity).toBe(LINKED_CONTEXT_CAPACITY);
  });

  it('VT-08 / AC-3: denies out-of-scope project with PROJECT_FORBIDDEN', async () => {
    mockInterviewFindFirst.mockResolvedValue({
      id: INTERVIEW_ID,
      project: 'Other',
      status: 'in_progress',
    });
    mockGetAssignmentsForUser.mockResolvedValue(['Apex']);

    await expect(
      getLinkedContext(INTERVIEW_ID, { userId: 'user-ba', isSuperAdmin: false }),
    ).rejects.toMatchObject({ code: 'PROJECT_FORBIDDEN' });
  });
});

describe('interviewLinkService — mutations (PBI-001)', () => {
  it('VT-02 / AC-1: rejects 11th combined link with LinkCapExceeded', async () => {
    setupTransaction({ adrCount: 6, moduleCount: 4 });

    await expect(
      addDesignModuleLink(INTERVIEW_ID, ACTOR, { designModuleId: MODULE_ID }),
    ).rejects.toMatchObject({
      code: 'LINK_CAP_EXCEEDED',
      message: expect.stringContaining('10'),
    });
  });

  it('VT-04 / AC-3: rejects non-accepted ADR (AdrNotAccepted → 422 at route)', async () => {
    setupTransaction({
      adr: { id: ADR_ID, project: 'Apex', status: 'proposed' },
    });

    await expect(
      addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID }),
    ).rejects.toMatchObject({ code: 'ADR_NOT_ACCEPTED' });
  });

  it('VT-04 / AC-3: rejects cross-project artifact', async () => {
    setupTransaction({
      adr: { id: ADR_ID, project: 'OtherProj', status: 'accepted' },
    });

    await expect(
      addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_CROSS_PROJECT' });
  });

  it('VT-04 / AC-3: rejects mutations on complete Interview', async () => {
    setupTransaction({
      interview: { id: INTERVIEW_ID, project: 'Apex', status: 'complete' },
    });

    await expect(
      addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID }),
    ).rejects.toMatchObject({ code: 'INTERVIEW_NOT_IN_PROGRESS' });
  });

  it('VT-04 / AC-3: rejects remove on archived Interview', async () => {
    setupTransaction({
      interview: { id: INTERVIEW_ID, project: 'Apex', status: 'archived' },
    });

    await expect(
      removeAdrLink(INTERVIEW_ID, ACTOR, ADR_ID),
    ).rejects.toMatchObject({ code: 'INTERVIEW_NOT_IN_PROGRESS' });
  });

  it('VT-03 / AC-2: maps unique violation to LINK_DUPLICATE', async () => {
    setupTransaction({
      insertError: { code: '23505' },
    });

    await expect(
      addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID }),
    ).rejects.toMatchObject({ code: 'LINK_DUPLICATE' });
  });

  it('VT-01 / AC-0: creates audited ADR link and returns read model', async () => {
    setupTransaction({ adrCount: 0, moduleCount: 0 });
    mockAdrLinksFindMany.mockResolvedValue([
      {
        adrId: ADR_ID,
        linkedBy: 'user-ba',
        linkedAt: '2026-08-05T12:00:00.000Z',
        adr: { title: 'Async Infra', status: 'accepted' },
      },
    ]);

    const result = await addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID });
    expect(result.linkedContext.adrLinks).toHaveLength(1);
    expect(result.linkedContext.adrLinks[0].linkedBy).toBe('user-ba');
    expect(result.linkedContext.count).toBe(1);
  });

  it('VT-10: uses FOR UPDATE lock before counting (concurrency guard)', async () => {
    let executeCalled = false;
    let selectAfterLock = false;
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: jest.fn().mockImplementation(async () => {
          executeCalled = true;
          return { rows: [{ id: INTERVIEW_ID, project: 'Apex', status: 'in_progress' }] };
        }),
        query: {
          adrs: {
            findFirst: jest.fn().mockResolvedValue({
              id: ADR_ID,
              project: 'Apex',
              status: 'accepted',
            }),
          },
        },
        select: jest.fn().mockImplementation(() => {
          if (executeCalled) selectAfterLock = true;
          return countChain(9);
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockResolvedValue(undefined),
        }),
      };
      // First select is adr count (9), second is module count — need alternating
      let calls = 0;
      tx.select = jest.fn().mockImplementation(() => {
        if (executeCalled) selectAfterLock = true;
        calls += 1;
        return countChain(calls === 1 ? 5 : 4); // 9 total — under cap, insert OK
      });
      return fn(tx);
    });

    await addAdrLink(INTERVIEW_ID, ACTOR, { adrId: ADR_ID });
    expect(selectAfterLock).toBe(true);
  });
});

describe('interviewLinkService — TBI-001 persistence contracts', () => {
  it('DoD: shared types expose capacity 10 and InterviewLinkError codes', () => {
    expect(LINKED_CONTEXT_CAPACITY).toBe(10);
    const err = new InterviewLinkError('LINK_CAP_EXCEEDED', 'cap');
    expect(err.code).toBe('LINK_CAP_EXCEEDED');
    expect(err).toBeInstanceOf(Error);
  });
});
