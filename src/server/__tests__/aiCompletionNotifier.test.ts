/**
 * Unit tests for aiCompletionNotifier.
 * The Drizzle `db` instance and notificationService are fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        prds: { findFirst: jest.fn() },
        designDocs: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
        designPrototypes: { findFirst: jest.fn() },
      },
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_col: unknown, val: unknown) => ({ _tag: 'eq', val })),
  and: jest.fn((...args: unknown[]) => ({ _tag: 'and', args })),
}));

jest.mock('../db/schema', () => ({
  prds: { id: 'prds.id', interviewId: 'prds.interviewId' },
  designDocs: { id: 'designDocs.id', prdId: 'designDocs.prdId' },
  testCases: { id: 'testCases.id', prdId: 'testCases.prdId' },
  designPrototypes: { id: 'designPrototypes.id', prdId: 'designPrototypes.prdId' },
  documentApproverAssignments: {
    approverUserId: 'daa.approverUserId',
    documentId: 'daa.documentId',
    documentType: 'daa.documentType',
  },
  interviews: {
    prdOwnerId: 'interviews.prdOwnerId',
    designDocOwnerId: 'interviews.designDocOwnerId',
    designPrototypeOwnerId: 'interviews.designPrototypeOwnerId',
  },
}));

import { notifyAiCompletion } from '../services/aiCompletionNotifier';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const { createNotification: mockCreateNotification } = jest.requireMock(
  '../services/notificationService',
) as { createNotification: jest.Mock };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const interviewFixture = {
  prdOwnerId: 'owner-prd',
  designDocOwnerId: 'owner-dd',
  designPrototypeOwnerId: 'owner-proto',
};

function mockResolveFromPrd(interview = interviewFixture) {
  mockDb.query.prds.findFirst.mockResolvedValue({
    interviewId: 'interview-1',
    interview,
  });
}

function mockResolveFromDesignDoc(interview = interviewFixture) {
  mockDb.query.designDocs.findFirst.mockResolvedValue({
    prdId: 'prd-1',
    prd: {
      interviewId: 'interview-1',
      interview,
    },
  });
}

function mockResolveFromTestCase(interview = interviewFixture) {
  mockDb.query.testCases.findFirst.mockResolvedValue({
    prdId: 'prd-1',
    prd: {
      interviewId: 'interview-1',
      interview,
    },
  });
}

function mockResolveFromPrototype(interview = interviewFixture) {
  mockDb.query.designPrototypes.findFirst.mockResolvedValue({
    prdId: 'prd-1',
    prd: {
      interviewId: 'interview-1',
      interview,
    },
  });
}

function mockReviewerSelect(approverUserIds: string[]) {
  const rows = approverUserIds.map((id) => ({ approverUserId: id }));
  const whereMock = jest.fn().mockResolvedValue(rows);
  const fromMock = jest.fn().mockReturnValue({ where: whereMock });
  mockDb.select.mockReturnValue({ from: fromMock });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('notifyAiCompletion', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── (a) prd_generated: resolves owner, sends correct notification ──────

  it('prd_generated: resolves owner from interview chain and sends notification', async () => {
    mockResolveFromPrd();
    mockReviewerSelect([]);

    await notifyAiCompletion('prd_generated', 'prd-1', { title: 'My PRD' });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-prd', {
      type: 'ai',
      title: 'PRD generation complete',
      body: 'Your PRD "My PRD" has been generated',
      link: '/backlog/prd/prd-1',
    });
  });

  // ── (b) prd_generated with null owner → no notification ────────────────

  it('prd_generated: does NOT call createNotification when prdOwnerId is null', async () => {
    mockResolveFromPrd({
      prdOwnerId: null as any,
      designDocOwnerId: 'owner-dd',
      designPrototypeOwnerId: 'owner-proto',
    });
    mockReviewerSelect([]);

    await notifyAiCompletion('prd_generated', 'prd-1', { title: 'My PRD' });

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  // ── (c) prd_validation_complete: notifies owner AND reviewers ──────────

  it('prd_validation_complete: notifies owner and assigned reviewers', async () => {
    mockResolveFromPrd();
    mockReviewerSelect(['reviewer-1', 'reviewer-2']);

    await notifyAiCompletion('prd_validation_complete', 'prd-1', {
      title: 'My PRD',
      score: 85,
      passed: true,
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-prd', expect.objectContaining({
      type: 'ai',
      title: 'PRD validation complete',
      body: 'Validation passed for "My PRD" (score: 85)',
      link: '/backlog/prd/prd-1',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('reviewer-1', expect.objectContaining({
      type: 'ai',
      title: 'PRD validation complete',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('reviewer-2', expect.objectContaining({
      type: 'ai',
      title: 'PRD validation complete',
    }));
  });

  // ── (d) deduplication: owner == reviewer → only one call ───────────────

  it('deduplicates when owner is also a reviewer', async () => {
    mockResolveFromPrd();
    mockReviewerSelect(['owner-prd', 'reviewer-2']);

    await notifyAiCompletion('prd_validation_complete', 'prd-1', {
      title: 'My PRD',
      score: 70,
      passed: false,
    });

    const calledUserIds = mockCreateNotification.mock.calls.map((c: any[]) => c[0]);
    expect(calledUserIds).toHaveLength(2);
    expect(new Set(calledUserIds)).toEqual(new Set(['owner-prd', 'reviewer-2']));
  });

  // ── (e) does not throw when DB query fails ────────────────────────────

  it('does not throw when DB query fails', async () => {
    mockDb.query.prds.findFirst.mockRejectedValue(new Error('DB connection lost'));

    await expect(
      notifyAiCompletion('prd_generated', 'prd-1', { title: 'Failing PRD' }),
    ).resolves.toBeUndefined();

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  // ── (f) design_prototype_generated: resolves prdId from prototype ─────

  it('design_prototype_generated: resolves prdId, notifies prototype owner + approvers', async () => {
    mockResolveFromPrototype();
    mockReviewerSelect(['reviewer-proto']);

    await notifyAiCompletion('design_prototype_generated', 'proto-1', {
      title: 'Login Screen',
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-proto', expect.objectContaining({
      type: 'ai',
      title: 'Design prototype ready',
      body: 'Prototype for "Login Screen" is ready for review',
      link: '/backlog/design-prototype/prd-1',
    }));
    expect(mockCreateNotification).toHaveBeenCalledWith('reviewer-proto', expect.objectContaining({
      type: 'ai',
      title: 'Design prototype ready',
    }));
  });

  // ── Additional event coverage ──────────────────────────────────────────

  it('test_cases_generated: resolves prdId from testCase and notifies owner', async () => {
    mockResolveFromTestCase();
    mockReviewerSelect([]);

    await notifyAiCompletion('test_cases_generated', 'tc-1', { title: 'Auth Tests' });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-prd', expect.objectContaining({
      type: 'ai',
      title: 'Test cases generated',
      body: 'Test cases for "Auth Tests" are ready',
      link: '/backlog/prd/prd-1',
    }));
  });

  it('prd_fix_complete: notifies owner and reviewers', async () => {
    mockResolveFromPrd();
    mockReviewerSelect(['reviewer-1']);

    await notifyAiCompletion('prd_fix_complete', 'prd-1', { title: 'My PRD' });

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-prd', expect.objectContaining({
      type: 'ai',
      title: 'PRD fix applied',
      body: 'Apex fix applied to "My PRD" — re-validation started',
      link: '/backlog/prd/prd-1',
    }));
  });

  it('design_doc_generated: notifies designDocOwner', async () => {
    mockResolveFromDesignDoc();
    mockReviewerSelect([]);

    await notifyAiCompletion('design_doc_generated', 'dd-1', { title: 'Auth Design' });

    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-dd', expect.objectContaining({
      type: 'ai',
      title: 'Design doc generated',
      body: 'Design doc "Auth Design" has been generated',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('design_doc_validation_complete: notifies owner and reviewers with score', async () => {
    mockResolveFromDesignDoc();
    mockReviewerSelect(['reviewer-dd']);

    await notifyAiCompletion('design_doc_validation_complete', 'dd-1', {
      title: 'Auth Design',
      score: 92,
      passed: true,
    });

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-dd', expect.objectContaining({
      type: 'ai',
      title: 'Design doc validation complete',
      body: 'Validation passed for "Auth Design" (score: 92)',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('design_doc_fix_complete: notifies owner and reviewers', async () => {
    mockResolveFromDesignDoc();
    mockReviewerSelect(['reviewer-dd']);

    await notifyAiCompletion('design_doc_fix_complete', 'dd-1', { title: 'Auth Design' });

    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith('owner-dd', expect.objectContaining({
      type: 'ai',
      title: 'Design doc fix applied',
      body: 'Apex fix applied to "Auth Design" — re-validation started',
      link: '/backlog/design-doc/dd-1',
    }));
  });

  it('prd_validation_complete with passed=false shows "needs attention"', async () => {
    mockResolveFromPrd();
    mockReviewerSelect([]);

    await notifyAiCompletion('prd_validation_complete', 'prd-1', {
      title: 'My PRD',
      score: 40,
      passed: false,
    });

    expect(mockCreateNotification).toHaveBeenCalledWith('owner-prd', expect.objectContaining({
      body: 'Validation needs attention for "My PRD" (score: 40)',
    }));
  });
});
