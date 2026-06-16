/**
 * Unit tests for prdService.
 * The Drizzle `db` instance and chatAgentService are fully mocked.
 */

// ── DB mock ────────────────────────────────────────────────────────────────────

jest.mock('../db/drizzle', () => {
  const makeInsertChain = () => ({
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  });

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeDeleteChain = () => ({
    where: jest.fn().mockResolvedValue(undefined),
  });

  const makeSelectChain = () => ({
    from: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
    limit: jest.fn().mockResolvedValue([]),
  });

  return {
    db: {
      query: {
        prds: { findFirst: jest.fn() },
        interviews: { findFirst: jest.fn() },
        testCases: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  createThread: jest.fn().mockResolvedValue({ id: 'thread-new', workspaceDir: '/tmp/thread-new' }),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn().mockResolvedValue([]),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(true),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: true, mode: 'any_one' }),
  notifyApproversDocumentReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
  getApproverUserIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/designSystemService', () => ({
  inferRoutesForBacklog: jest.fn().mockImplementation((backlog: unknown) => Promise.resolve({ backlog })),
}));

jest.mock('../services/bedrockService', () => ({
  enrichBacklogPersonasWithBedrock: jest.fn().mockImplementation((backlog: unknown) => Promise.resolve(backlog)),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));

jest.mock('../services/documentValidationService', () => ({
  autoStartDocumentValidation: jest.fn().mockResolvedValue(undefined),
  cancelDocumentValidation: jest.fn().mockResolvedValue(undefined),
  generateFallbackReport: jest.fn().mockReturnValue('# Fallback validation report'),
  isDocumentValidationWatcherActive: jest.fn().mockReturnValue(false),
  startDocumentValidationWatcher: jest.fn(),
  stopDocumentValidationWatcher: jest.fn(),
}));

jest.mock('../services/testCaseService', () => ({
  getTestCases: jest.fn().mockResolvedValue({
    id: 'tc-1',
    prdId: 'prd-1',
    chatThreadId: null,
    status: 'ready',
    coverageSummary: {
      totalCases: 2,
      pbisCovered: 1,
      acCovered: '2/2',
      brCovered: '1/1',
      gaps: 0,
    },
    validationStatus: 'passed',
    validationSummary: { status: 'passed' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }),
  listLatestTestCaseSummariesForPrds: jest.fn().mockResolvedValue(new Map()),
  triggerTestCaseGeneration: jest.fn().mockResolvedValue(true),
}));

import {
  createPrd,
  listPrds,
  getPrd,
  updatePrdContent,
  updatePrdBacklog,
  submitForReview,
  withdrawFromReview,
  reopenForReview,
  reviewPrd,
  deletePrd,
  syncPrdContent,
  startPrdWatcher,
  arePrdValidationArtifactsReady,
  autoStartPrdValidation,
  cancelPrdValidation,
  syncPrdValidationResult,
  markPrdValidationReady,
  triggerFixPrdValidation,
  acceptFixPrdValidation,
  revertPrdSection,
} from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const {
  readOutputPrd: mockReadOutputPrd,
  readOutputBacklog: mockReadOutputBacklog,
  readOutputValidationScorecard: mockReadOutputValidationScorecard,
  readOutputValidationScorecardMd: mockReadOutputValidationScorecardMd,
  sendMessage: mockSendMessage,
  createThread: mockCreateThread,
} = jest.requireMock('../services/chatAgentService') as {
  readOutputPrd: jest.Mock;
  readOutputBacklog: jest.Mock;
  readOutputValidationScorecard: jest.Mock;
  readOutputValidationScorecardMd: jest.Mock;
  sendMessage: jest.Mock;
  createThread: jest.Mock;
};

const { isAdminUser: mockIsAdminUser } = jest.requireMock('../utils/rbacHelpers') as {
  isAdminUser: jest.Mock;
};

const {
  assignApprovers: mockAssignApprovers,
  recordApproverResponse: mockRecordApproverResponse,
  isAssignedApprover: mockIsAssignedApprover,
  isApprovalComplete: mockIsApprovalComplete,
  notifyApproversDocumentReady: mockNotifyApproversDocumentReady,
} = jest.requireMock('../services/documentApprovalService') as {
  assignApprovers: jest.Mock;
  recordApproverResponse: jest.Mock;
  isAssignedApprover: jest.Mock;
  isApprovalComplete: jest.Mock;
  notifyApproversDocumentReady: jest.Mock;
};

const {
  getTestCases: mockGetTestCases,
  listLatestTestCaseSummariesForPrds: mockListLatestTestCaseSummariesForPrds,
  triggerTestCaseGeneration: mockTriggerTestCaseGeneration,
} = jest.requireMock('../services/testCaseService') as {
  getTestCases: jest.Mock;
  listLatestTestCaseSummariesForPrds: jest.Mock;
  triggerTestCaseGeneration: jest.Mock;
};

const { getSkillConfig: mockGetSkillConfig } = jest.requireMock('../services/projectSettingsService') as {
  getSkillConfig: jest.Mock;
};

const { getDefaultModel: mockGetDefaultModel } = jest.requireMock('../services/appSettingsService') as {
  getDefaultModel: jest.Mock;
};

const {
  autoStartDocumentValidation: mockAutoStartDocumentValidation,
  cancelDocumentValidation: mockCancelDocumentValidation,
} = jest.requireMock('../services/documentValidationService') as {
  autoStartDocumentValidation: jest.Mock;
  cancelDocumentValidation: jest.Mock;
};

const readyTestCase = {
  id: 'tc-1',
  prdId: 'prd-1',
  chatThreadId: null,
  status: 'ready',
  coverageSummary: {
    totalCases: 2,
    pbisCovered: 1,
    acCovered: '2/2',
    brCovered: '1/1',
    gaps: 0,
  },
  validationStatus: 'passed',
  validationSummary: { status: 'passed' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  mockGetTestCases.mockResolvedValue(readyTestCase);
  mockListLatestTestCaseSummariesForPrds.mockResolvedValue(new Map());
  mockTriggerTestCaseGeneration.mockResolvedValue(true);
  mockGetSkillConfig.mockResolvedValue(null);
  mockGetDefaultModel.mockResolvedValue('default-model');
  mockReadOutputValidationScorecard.mockReturnValue(null);
  mockReadOutputValidationScorecardMd.mockReturnValue(null);
  mockCreateThread.mockResolvedValue({ id: 'thread-new', workspaceDir: '/tmp/thread-new' });
  mockSendMessage.mockResolvedValue(undefined);
});

// ── Select chain helper ────────────────────────────────────────────────────────
// Services now issue multiple .leftJoin() calls before .where()/.orderBy()/.limit().
// This helper builds a self-referential mock chain that satisfies any number of joins.

function makeSelectChain(data: unknown[], terminal: 'limit' | 'orderBy' = 'limit') {
  const resolved = jest.fn().mockResolvedValue(data);
  const chain: Record<string, jest.Mock> = {};
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = terminal === 'orderBy' ? resolved : jest.fn().mockResolvedValue(data);
  chain.limit = terminal === 'limit' ? resolved : jest.fn().mockResolvedValue(data);
  return { from: jest.fn().mockReturnValue(chain) };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makePrdRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'prd-1',
    interviewId: 'interview-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    project: 'proj-alpha',
    title: 'Feature PRD',
    content: 'Some content',
    backlogJson: null,
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

// ── createPrd ──────────────────────────────────────────────────────────────────

describe('createPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new PRD in "generating" status and returns prdId + threadId', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'prd-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createPrd({
      interviewId: 'interview-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'My PRD',
    });

    expect(result).toEqual({ prdId: 'prd-new', threadId: 'thread-abc' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        interviewId: 'interview-1',
        authorId: 'user-1',
        chatThreadId: 'thread-abc',
        title: 'My PRD',
        status: 'generating',
        content: '',
      }),
    );
  });

  it('defaults title to "Untitled PRD" when not supplied', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'prd-untitled' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createPrd({ interviewId: 'i1', project: 'proj-1', userId: 'u1', chatThreadId: 't1' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untitled PRD' }),
    );
  });
});

// ── listPrds ───────────────────────────────────────────────────────────────────

describe('listPrds', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns all PRDs when no filters are given', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

    const result = await listPrds();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'prd-1', status: 'draft' });
  });

  it('returns an empty array when no PRDs match', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([], 'orderBy'));

    const result = await listPrds({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only PRDs linked to the specified project', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

    const result = await listPrds({ project: 'proj-alpha' });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('prd-1');
    expect(result[0].interviewId).toBe('interview-1');
    // The project filter is applied directly in the single query (no two-step lookup)
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no PRDs exist for the given project', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([], 'orderBy'));

    const result = await listPrds({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('does not return PRDs from other projects', async () => {
    // The DB filters by project directly; mock returns only proj-alpha PRDs
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));

    const result = await listPrds({ project: 'proj-alpha' });

    expect(result.every((p) => p.interviewId === 'interview-1')).toBe(true);
    expect(result.every((p) => p.id !== 'prd-beta')).toBe(true);
  });

  it('attaches the latest test-case summary to each PRD summary', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: makePrdRow(), reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }], 'orderBy'));
    mockListLatestTestCaseSummariesForPrds.mockResolvedValue(new Map([['prd-1', readyTestCase]]));

    const result = await listPrds();

    expect(mockListLatestTestCaseSummariesForPrds).toHaveBeenCalledWith(['prd-1']);
    expect(result[0].latestTestCase).toMatchObject({
      id: 'tc-1',
      status: 'ready',
      coverageSummary: expect.objectContaining({ totalCases: 2 }),
    });
  });
});

// ── getPrd ─────────────────────────────────────────────────────────────────────

describe('getPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a full PRD with content and backlogJson', async () => {
    const prdRow = makePrdRow({ content: 'Detailed content', backlogJson: { items: [] } });
    mockDb.select.mockReturnValue(makeSelectChain([{ prd: prdRow, reviewerDisplayName: null, authorDisplayName: null, prdOwnerId: null, prdOwnerDisplayName: null }]));

    const result = await getPrd('prd-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('prd-1');
    expect(result!.content).toBe('Detailed content');
    expect(result!.backlogJson).toEqual({ items: [] });
  });

  it('returns null when the PRD does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const result = await getPrd('prd-missing');

    expect(result).toBeNull();
  });

  it('returns validation metadata and whether PRD validation is configured', async () => {
    const scorecard = {
      slug: 'feature-prd',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'final',
      overall_score: 92,
      ready_threshold: 90,
      is_ready: true,
      verdict: 'ready',
      files: [],
    };
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow({
        validationThreadId: 'validation-thread-1',
        validationScore: 92,
        validationScorecard: scorecard,
        validationReportMd: '# Report',
        validationPhase: 'final',
        fixBaseline: { content: 'baseline', capturedAt: '2026-01-01T00:00:00Z' },
        fixCommentId: 'comment-1',
      }),
      reviewerDisplayName: null,
      authorDisplayName: null,
      prdOwnerId: null,
      prdOwnerDisplayName: null,
    }]));
    mockGetSkillConfig.mockResolvedValue({ prdValidationSkillPath: '.cursor/skills/prd-validation/SKILL.md' });

    const result = await getPrd('prd-1');

    expect(result).toMatchObject({
      validationThreadId: 'validation-thread-1',
      validationScore: 92,
      validationScorecard: scorecard,
      validationReportMd: '# Report',
      validationPhase: 'final',
      prdValidationEnabled: true,
      fixCommentId: 'comment-1',
    });
    expect(result!.fixBaseline).toMatchObject({ content: 'baseline' });
    expect(result!.latestTestCase).toMatchObject({ id: 'tc-1' });
  });
});

// ── updatePrdContent ───────────────────────────────────────────────────────────

describe('updatePrdContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates content when author edits a draft PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'user-1', 'Updated content');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated content' }));
  });

  it('resets status to "draft" and clears review fields when editing a revision_requested PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'revision_requested', reviewerId: 'reviewer-1', reviewComment: 'Fix it' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'user-1', 'Revised content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', reviewerId: null }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(updatePrdContent('prd-missing', 'user-1', 'x')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to edit', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(updatePrdContent('prd-1', 'user-other', 'x')).rejects.toMatchObject({
      message: 'Only the author or owner can edit PRD content',
    });
  });

  it('throws 409 when trying to edit an approved PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdContent('prd-1', 'user-1', 'x')).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });

  it('allows the document owner (interview.prdOwnerId) to edit content', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updatePrdContent('prd-1', 'owner-user', 'Owner updated content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Owner updated content' }),
    );
  });
});

// ── submitForReview ────────────────────────────────────────────────────────────

describe('submitForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a draft PRD to pending_review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 409 when PRD content is empty', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ content: '' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: 'PRD content must be non-empty before submitting for review',
    });
  });

  it('throws 409 when PRD is already pending_review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review', content: 'x' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit PRD from status 'pending_review'"),
    });
  });

  it('throws 409 when PRD is already approved', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved', content: 'x' }));

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit PRD from status 'approved'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(submitForReview('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to submit', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ content: 'x' }));

    await expect(submitForReview('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can submit for review',
    });
  });

  it('allows the document owner to submit for review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'owner-user');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('calls assignApprovers when prdApproverIds provided', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1', { prdApproverIds: ['a1'], designDocApproverIds: ['a2'] });

    expect(mockAssignApprovers).toHaveBeenCalledWith('prd-1', 'prd', ['a1'], 'user-1');
  });

  it('blocks submission until PRD QA readiness is complete', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    mockGetTestCases.mockResolvedValue(null);

    await expect(submitForReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: 'Generate PRD test cases before submitting for review.',
      status: 409,
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('stores designDocApproverIds on PRD row when provided', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', content: 'some content' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('prd-1', 'user-1', { prdApproverIds: [], designDocApproverIds: ['a2'] });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ designDocApproverIds: ['a2'] }),
    );
  });
});

// ── withdrawFromReview ─────────────────────────────────────────────────────────

describe('withdrawFromReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a pending_review PRD back to draft', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('throws 409 when PRD is not in pending_review status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));

    await expect(withdrawFromReview('prd-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot withdraw PRD from status 'draft'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(withdrawFromReview('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to withdraw', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));

    await expect(withdrawFromReview('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can withdraw from review',
    });
  });

  it('allows the document owner to withdraw from review', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'pending_review' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('prd-1', 'owner-user');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });
});

// ── reviewPrd ─────────────────────────────────────────────────────────────────

describe('reviewPrd', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingPrd = makePrdRow({ status: 'pending_review', authorId: 'user-author' });

  it('approves a pending_review PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('throws 400 for invalid review action', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'request_revision' } as any),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Invalid review action'),
      status: 400,
    });
  });

  it('throws 403 when the author tries to review their own PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);

    await expect(
      reviewPrd('prd-1', 'user-author', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You cannot review your own PRD',
      status: 403,
    });
  });

  it('throws 409 when PRD is not in pending_review status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft', authorId: 'user-author' }));

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Cannot review PRD from status 'draft'"),
    });
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(
      reviewPrd('prd-missing', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({ message: 'PRD not found' });
  });

  it('throws 403 when reviewer is not an assigned approver and not admin', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(false);

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You are not an assigned approver for this PRD',
      status: 403,
    });
  });

  it('allows admin to review even if not an assigned approver', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('does not transition to approved if isApprovalComplete returns false', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('transitions to approved when isApprovalComplete returns true', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('admin approval bypasses isApprovalComplete check entirely', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-admin', { action: 'approve' });

    expect(mockIsApprovalComplete).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
  });

  it('designated approver approval transitions PRD to approved (any_one mode)', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(pendingPrd);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewPrd('prd-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalledWith(
      'prd-1', 'prd', 'user-reviewer', 'approved',
    );
    expect(mockIsApprovalComplete).toHaveBeenCalledWith('prd-1', 'prd', 'proj-alpha');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('blocks approval when readiness has coverage gaps', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({ ...pendingPrd, content: 'some content' });
    mockGetTestCases.mockResolvedValue({
      ...readyTestCase,
      coverageSummary: {
        totalCases: 2,
        pbisCovered: 1,
        acCovered: '1/2',
        brCovered: '1/1',
        gaps: 0,
      },
    });

    await expect(
      reviewPrd('prd-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'Resolve coverage gaps before review.',
      status: 409,
    });
    expect(mockRecordApproverResponse).not.toHaveBeenCalled();
  });
});

// ── deletePrd ──────────────────────────────────────────────────────────────────

describe('deletePrd', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the PRD when the requesting user is the author', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deletePrd('prd-1', 'user-1');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(deletePrd('prd-missing', 'user-1')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(deletePrd('prd-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can delete this PRD',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });

  it('allows the document owner to delete the PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deletePrd('prd-1', 'owner-user');

    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });
});

// ── syncPrdContent ─────────────────────────────────────────────────────────────

describe('syncPrdContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates content and sets status to "draft" by default', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncPrdContent('prd-1', 'Generated markdown content');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Generated markdown content', status: 'draft' }),
    );
  });

  it('accepts a custom final status', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncPrdContent('prd-1', 'content', undefined, 'pending_review');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('includes backlogJson when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 1, title: 'Task A' }] };
    await syncPrdContent('prd-1', 'content', backlog);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ backlogJson: backlog }),
    );
  });
});

// ── updatePrdBacklog ──────────────────────────────────────────────────────────

describe('updatePrdBacklog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates backlogJson when author edits a draft PRD', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 1, title: 'Task A' }] };
    await updatePrdBacklog('prd-1', 'user-1', backlog);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ backlogJson: backlog }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(updatePrdBacklog('prd-missing', 'user-1', {})).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('throws 403 when a non-author tries to update', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());

    await expect(updatePrdBacklog('prd-1', 'user-other', {})).rejects.toMatchObject({
      message: 'Only the author or owner can update backlog',
    });
  });

  it('throws 409 when PRD status is approved', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'approved' }));

    await expect(updatePrdBacklog('prd-1', 'user-1', {})).rejects.toMatchObject({
      message: 'Approved PRDs cannot be edited',
    });
  });

  it('allows the document owner to update the backlog', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    mockDb.select.mockReturnValueOnce(makeSelectChain([{ prdOwnerId: 'owner-user' }]));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const backlog = { items: [{ id: 2, title: 'Owner task' }] };
    await updatePrdBacklog('prd-1', 'owner-user', backlog);

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ backlogJson: backlog }));
  });
});

// ── reopenForReview ───────────────────────────────────────────────────────────

describe('reopenForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sets status to pending_review and clears review fields', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(
      makePrdRow({ status: 'approved', reviewerId: 'reviewer-1', reviewComment: 'LGTM', reviewedAt: '2026-01-03T00:00:00Z' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reopenForReview('prd-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending_review',
        reviewerId: null,
        reviewedAt: null,
      }),
    );
  });

  it('throws 404 when PRD does not exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    await expect(reopenForReview('prd-missing')).rejects.toMatchObject({
      message: 'PRD not found',
    });
  });

  it('works from draft status', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reopenForReview('prd-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });
});

// ── startPrdWatcher ───────────────────────────────────────────────────────────

describe('startPrdWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('syncs content to DB when both files are found', async () => {
    mockReadOutputPrd.mockReturnValue('# Generated PRD');
    mockReadOutputBacklog.mockReturnValue({ epics: [] });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    // Also mock the workspace cleanup query
    mockDb.query.prds.findFirst.mockResolvedValue(null);

    startPrdWatcher('prd-1', 'thread-1');

    // Advance past one interval tick
    jest.advanceTimersByTime(5_000);
    // Flush microtasks for the async operations in syncPrdContent
    // (dynamic imports of designSystemService, bedrockService, and DB updates)
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(mockReadOutputPrd).toHaveBeenCalledWith('thread-1');
    expect(mockReadOutputBacklog).toHaveBeenCalledWith('thread-1');
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# Generated PRD', status: 'draft' }),
    );
  });

  it('resets PRD to draft when watcher times out without finding files', async () => {
    mockReadOutputPrd.mockReturnValue(null);
    mockReadOutputBacklog.mockReturnValue(null);

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startPrdWatcher('prd-1', 'thread-1');

    // Advance past all 360 ticks + 1 to trigger the timeout
    for (let i = 0; i <= 360; i++) {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('does not sync when only PRD file is found without backlog', async () => {
    mockReadOutputPrd.mockReturnValue('# PRD');
    mockReadOutputBacklog.mockReturnValue(null);

    const setMock = jest.fn().mockReturnThis();
    mockDb.update.mockReturnValue({ set: setMock });

    startPrdWatcher('prd-1', 'thread-1');

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    await Promise.resolve();

    // syncPrdContent should NOT have been called (requires both files)
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.any(String), status: 'pending_review' }),
    );
  });
});

// ── PRD validation lifecycle ───────────────────────────────────────────────────

describe('PRD validation lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  function mockPrdSelectForGetPrd(overrides: Partial<Record<string, any>> = {}) {
    mockDb.select.mockReturnValue(makeSelectChain([{
      prd: makePrdRow({
        status: 'draft',
        content: '# PRD',
        backlogJson: { items: [] },
        validationThreadId: 'validation-thread-1',
        validationScorecard: {
          slug: 'feature-prd',
          generated_at: '2026-01-01T00:00:00Z',
          review_phase: 'initial',
          overall_score: 82,
          ready_threshold: 90,
          is_ready: false,
          verdict: 'gaps',
          files: [{
            file: 'prd',
            score: 82,
            verdict: 'gaps',
            gaps: [{
              id: 'gap-1',
              file: 'prd',
              section: 'Acceptance Criteria',
              score: 2,
              description: 'Clarify expected error handling.',
              what_3_looks_like: 'Each error path has clear expected behavior.',
              resolution: 'pending',
            }],
          }],
        },
        ...overrides,
      }),
      reviewerDisplayName: null,
      authorDisplayName: null,
      prdOwnerId: null,
      prdOwnerDisplayName: null,
    }]));
  }

  it('reports artifacts ready only when PRD content, backlog, and ready test cases exist', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({ content: '# PRD', backlogJson: { items: [] } });
    mockDb.query.testCases.findFirst.mockResolvedValue({ id: 'tc-ready' });

    await expect(arePrdValidationArtifactsReady('prd-1')).resolves.toBe(true);

    mockDb.query.prds.findFirst.mockResolvedValue({ content: '# PRD', backlogJson: null });
    await expect(arePrdValidationArtifactsReady('prd-1')).resolves.toBe(false);
  });

  it('starts document validation only when a skill is configured and artifacts are ready', async () => {
    mockPrdSelectForGetPrd();
    mockGetSkillConfig.mockResolvedValue({
      skillRepo: 'org/skills',
      skillBranch: 'main',
      prdValidationSkillPath: '.cursor/skills/prd-validation/SKILL.md',
      prdValidationModel: 'gpt-5.5',
    });
    mockDb.query.prds.findFirst.mockResolvedValue({ content: '# PRD', backlogJson: { items: [] } });
    mockDb.query.testCases.findFirst.mockResolvedValue({ id: 'tc-ready' });

    await autoStartPrdValidation('prd-1');

    expect(mockAutoStartDocumentValidation).toHaveBeenCalledTimes(1);
    const adapter = mockAutoStartDocumentValidation.mock.calls[0][0];
    expect(adapter.getDocumentId()).toBe('prd-1');
    expect(adapter.getSkillPath({ prdValidationSkillPath: 'skill.md' })).toBe('skill.md');
    expect(adapter.getModel({ prdValidationModel: 'model-a' }, 'global-model')).toBe('model-a');
    expect(adapter.buildValidationContext({})).toContain('## Backlog JSON');
    expect(adapter.buildValidationContext({})).toContain('TBIs');
    expect(adapter.buildValidationContext({})).toContain('must **NOT** have `userTypes`');
  });

  it('cancels validation and resets status to draft', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(
      makePrdRow({ status: 'validating', validationThreadId: 'validation-thread-1' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await cancelPrdValidation('prd-1', 'user-1');

    expect(mockCancelDocumentValidation).toHaveBeenCalledWith('prd-1', 'validation-thread-1');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('syncs a validation scorecard and moves ready PRDs to pending review', async () => {
    mockPrdSelectForGetPrd({ status: 'validating', validationThreadId: 'validation-thread-1' });
    const scorecard = {
      slug: 'feature-prd',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'final',
      overall_score: 93.4,
      ready_threshold: 90,
      is_ready: true,
      verdict: 'ready',
      files: [],
    };
    mockReadOutputValidationScorecard.mockReturnValue(JSON.stringify(scorecard));
    mockReadOutputValidationScorecardMd.mockReturnValue('# Validation Report');
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await syncPrdValidationResult('prd-1');

    expect(result).toEqual({ score: 93.4, is_ready: true });
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        validationScore: 93,
        validationScorecard: scorecard,
        validationReportMd: '# Validation Report',
        status: 'pending_review',
      }),
    );
  });

  it('marks validation ready only when the stored score meets threshold', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow({ validationScore: 91 }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markPrdValidationReady('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('prd-1', 'prd');
  });

  it('starts a validation-fix assistant thread, stores a baseline, and sends gap instructions', async () => {
    mockPrdSelectForGetPrd({ prdAssistantThreadId: null });
    mockGetSkillConfig.mockResolvedValue({
      skillRepo: 'org/skills',
      skillBranch: 'main',
      prdAssistantSkillPath: '.cursor/skills/prd-assistant/SKILL.md',
      prdAssistantModel: 'assistant-model',
    });
    mockCreateThread.mockResolvedValue({ id: 'thread-fix', workspaceDir: '/tmp/thread-fix' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await triggerFixPrdValidation('prd-1', 'user-1');

    expect(result).toEqual({ threadId: 'thread-fix' });
    expect(mockCreateThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        skillPath: '.cursor/skills/prd-assistant/SKILL.md',
        model: 'assistant-model',
      }),
      { skipAutoKickoff: true },
    );
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fixBaseline: expect.objectContaining({
          content: '# PRD',
          backlogJson: { items: [] },
          fixThreadId: 'thread-fix',
        }),
      }),
    );
    expect(mockSendMessage).toHaveBeenCalledWith(
      'thread-fix',
      expect.stringContaining('Clarify expected error handling.'),
    );
  });

  it('accepts a validation fix by clearing the baseline and restarting validation', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(makePrdRow());
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockPrdSelectForGetPrd();

    await acceptFixPrdValidation('prd-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ fixBaseline: null }));
    expect(mockAutoStartDocumentValidation).not.toHaveBeenCalled();
  });

  it('reverts PRD content and backlog from the stored validation baseline', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue(
      makePrdRow({
        fixBaseline: {
          content: '# Baseline PRD',
          backlogJson: { items: [{ id: 'pbi-1' }] },
          capturedAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await revertPrdSection('prd-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '# Baseline PRD',
        backlogJson: { items: [{ id: 'pbi-1' }] },
        fixBaseline: null,
      }),
    );
  });
});
