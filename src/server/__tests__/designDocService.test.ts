/**
 * Unit tests for designDocService.
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
        designDocs: { findFirst: jest.fn() },
        prds: { findFirst: jest.fn() },
        interviews: { findFirst: jest.fn() },
        designPlans: { findFirst: jest.fn() },
        designPrototypes: { findFirst: jest.fn() },
        agentRuns: { findFirst: jest.fn() },
      },
      insert: jest.fn().mockImplementation(makeInsertChain),
      update: jest.fn().mockImplementation(makeUpdateChain),
      delete: jest.fn().mockImplementation(makeDeleteChain),
      select: jest.fn().mockImplementation(makeSelectChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  readAllOutputDesignDocFeatures: jest.fn().mockReturnValue([]),
  isThreadIdle: jest.fn().mockReturnValue(false),
  isOutputWorkspaceReadable: jest.fn().mockReturnValue(true),
  createThread: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  prepareBackgroundWorkflowTurn: jest.fn().mockResolvedValue({
    prompt: 'complete frozen design prompt',
    model: 'design-model',
    skillPath: '/skills/design.md',
    projectId: 'proj-alpha',
    threadWorkspacePath: '/tmp/ws',
  }),
  cancelRun: jest.fn().mockResolvedValue(undefined),
  hydrateThread: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockImplementation(async (input: { runInProcess(): void }) => {
    await input.runInProcess();
    return { route: 'in-process', reason: 'flag-disabled' };
  }),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn().mockResolvedValue({ state: 'propagated' }),
  resolveRunGroundingSurface: jest.fn().mockResolvedValue(null),
  readActiveTargetProvenance: jest.fn().mockResolvedValue(null),
  runGroundingService: {
    getGroundings: jest.fn().mockImplementation(async (run: {
      runType: string;
      runId: string;
      project: string;
    }) => [{
      ...run,
      id: 'grounding-design',
      repoRole: 'target',
      provider: 'github',
      repository: 'org/repo',
      branch: 'main',
      groundedSha: 'abc123',
      groundedAt: '2026-08-06T00:00:00.000Z',
      isActive: true,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    }]),
    persistThenMarkTerminalInactive: jest.fn().mockImplementation(
      async (_run: unknown, persist: () => Promise<unknown>) => persist(),
    ),
  },
}));

jest.mock('../services/repoCacheLeaseService', () => ({
  tryAcquireRepoCacheLease: jest.fn(),
}));

jest.mock('../services/agentRunReaperService', () => ({
  isThreadRunAlive: jest.fn().mockResolvedValue(false),
  canThisInstanceFailGeneration: jest.fn().mockResolvedValue(true),
  // No row means the watcher charges the tick, matching a doc whose run never
  // materialized. Tests that exercise the queue wait override this.
  getLatestThreadRun: jest.fn().mockResolvedValue(null),
  getThreadRunStateSnapshot: jest.fn().mockResolvedValue({
    latestRun: null,
    shouldChargeWorkBudget: true,
    isAlive: false,
    canFailGeneration: true,
  }),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn().mockResolvedValue(null);
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});
jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));
jest.mock('../services/prdService', () => ({
  getPrd: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/documentApprovalService', () => ({
  assignApprovers: jest.fn().mockResolvedValue([]),
  recordApproverResponse: jest.fn().mockResolvedValue(undefined),
  isAssignedApprover: jest.fn().mockResolvedValue(true),
  isApprovalComplete: jest.fn().mockResolvedValue({ complete: true, mode: 'any_one' }),
  propagateDesignDocApprovers: jest.fn().mockResolvedValue(undefined),
  notifyApproversDocumentReady: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/reviewCommentService', () => ({
  getUnresolvedCount: jest.fn().mockResolvedValue(0),
}));

import {
  createDesignDoc,
  listDesignDocs,
  getDesignDoc,
  updateDesignDocContent,
  submitForReview,
  withdrawFromReview,
  reviewDesignDoc,
  routeDesignDocGenerationKickoff,
  deleteDesignDoc,
  syncDesignDocContent,
  syncValidationResult,
  markValidationReady,
  overrideDesignDocValidation,
  startDesignDocWatcher,
  startSingleFeatureDocWatcher,
  tryStartSingleFeatureDocWatcher,
  startSingleFeatureDesignDocWatcher,
  startValidationWatcher,
  finalizeSingleFeatureDoc,
  isSingleFeatureDesignDocRow,
  isDocWatcherActive,
} from '../services/designDocService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const {
  cancelRun: mockCancelRun,
  sendMessage: mockSendMessage,
  prepareBackgroundWorkflowTurn: mockPrepareBackgroundWorkflowTurn,
  hydrateThread: mockHydrateThread,
} = jest.requireMock('../services/chatAgentService') as {
  cancelRun: jest.Mock;
  sendMessage: jest.Mock;
  prepareBackgroundWorkflowTurn: jest.Mock;
  hydrateThread: jest.Mock;
};
const { routeBackgroundWorkflow: mockRouteBackgroundWorkflow } = jest.requireMock(
  '../services/backgroundWorkflowRouter',
) as { routeBackgroundWorkflow: jest.Mock };
const {
  propagatePipelineGrounding: mockPropagatePipelineGrounding,
  resolveRunGroundingSurface: mockResolveRunGroundingSurface,
  runGroundingService: mockRunGroundingService,
} = jest.requireMock('../services/runGroundingService') as {
  propagatePipelineGrounding: jest.Mock;
  resolveRunGroundingSurface: jest.Mock;
  runGroundingService: {
    getGroundings: jest.Mock;
    persistThenMarkTerminalInactive: jest.Mock;
  };
};
const {
  tryAcquireRepoCacheLease: mockTryAcquireRepoCacheLease,
} = jest.requireMock('../services/repoCacheLeaseService') as {
  tryAcquireRepoCacheLease: jest.Mock;
};
const {
  isThreadRunAlive: mockLegacyIsThreadRunAlive,
  canThisInstanceFailGeneration: mockLegacyCanFail,
  getLatestThreadRun: mockLegacyLatestRun,
  getThreadRunStateSnapshot: mockThreadRunStateSnapshot,
} = jest.requireMock('../services/agentRunReaperService') as {
  isThreadRunAlive: jest.Mock;
  canThisInstanceFailGeneration: jest.Mock;
  getLatestThreadRun: jest.Mock;
  getThreadRunStateSnapshot: jest.Mock;
};

// ── Select chain helper ────────────────────────────────────────────────────────
function makeSelectChain(data: unknown[], terminal: 'limit' | 'orderBy' = 'limit') {
  const resolved = jest.fn().mockResolvedValue(data);
  const chain: Record<string, jest.Mock> = {};
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = terminal === 'orderBy' ? resolved : jest.fn().mockResolvedValue(data);
  chain.limit = terminal === 'limit' ? resolved : jest.fn().mockResolvedValue(data);
  return { from: jest.fn().mockReturnValue(chain) };
}
const { getSkillConfig: mockGetSkillConfig } = jest.requireMock('../services/projectSettingsService') as { getSkillConfig: jest.Mock };

const { isAdminUser: mockIsAdminUser } = jest.requireMock('../utils/rbacHelpers') as {
  isAdminUser: jest.Mock;
};

const {
  assignApprovers: mockAssignApprovers,
  recordApproverResponse: mockRecordApproverResponse,
  isAssignedApprover: mockIsAssignedApprover,
  isApprovalComplete: mockIsApprovalComplete,
  notifyApproversDocumentReady: mockNotifyApproversDocumentReady,
  propagateDesignDocApprovers: mockPropagateDesignDocApprovers,
} = jest.requireMock('../services/documentApprovalService') as {
  assignApprovers: jest.Mock;
  recordApproverResponse: jest.Mock;
  isAssignedApprover: jest.Mock;
  isApprovalComplete: jest.Mock;
  notifyApproversDocumentReady: jest.Mock;
  propagateDesignDocApprovers: jest.Mock;
};

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeDocRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'doc-1',
    prdId: 'prd-1',
    chatThreadId: 'thread-1',
    authorId: 'user-1',
    project: 'proj-alpha',
    title: 'Feature Design Doc',
    designContent: 'Design content',
    techSpecContent: 'Tech spec content',
    assumptionsContent: 'Assumptions content',
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeHeldLease() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    assertOwned: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    controller,
  };
}

// ── createDesignDoc ────────────────────────────────────────────────────────────

describe('createDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('inserts a new design doc in "generating" status and returns designDocId', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    const result = await createDesignDoc({
      prdId: 'prd-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'My Design Doc',
      effort: 'high',
    });

    expect(result).toEqual({ designDocId: 'doc-new' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prdId: 'prd-1',
        authorId: 'user-1',
        chatThreadId: 'thread-abc',
        title: 'My Design Doc',
        effort: 'high',
        status: 'generating',
        designContent: '',
        techSpecContent: '',
        assumptionsContent: '',
      }),
    );
  });

  it('auto-assigns design doc reviewers from the parent PRD on create', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createDesignDoc({
      prdId: 'prd-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'My Design Doc',
    });

    expect(mockPropagateDesignDocApprovers).toHaveBeenCalledWith('prd-1', 'doc-new', 'user-1');
  });

  it('still returns the designDocId when reviewer propagation fails', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });
    mockPropagateDesignDocApprovers.mockRejectedValueOnce(new Error('assign failed'));

    await expect(
      createDesignDoc({
        prdId: 'prd-1',
        project: 'proj-alpha',
        userId: 'user-1',
        chatThreadId: 'thread-abc',
      }),
    ).resolves.toEqual({ designDocId: 'doc-new' });
  });

  it('defaults title to "Untitled Design Doc" when not supplied', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-untitled' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createDesignDoc({ prdId: 'prd-1', project: 'proj-1', userId: 'u1', chatThreadId: 't1' });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Untitled Design Doc' }),
    );
  });

  it('does not await pipeline grounding on create (kickoff owns propagation)', async () => {
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-fast' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    await createDesignDoc({
      prdId: 'prd-1',
      project: 'proj-alpha',
      userId: 'user-1',
      chatThreadId: 'thread-abc',
      title: 'Fast Create',
    });

    expect(mockPropagatePipelineGrounding).not.toHaveBeenCalled();
    expect(mockResolveRunGroundingSurface).not.toHaveBeenCalled();
  });
});

describe('routeDesignDocGenerationKickoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteBackgroundWorkflow.mockImplementation(
      async (input: { runInProcess(): void }) => {
        await input.runInProcess();
        return { route: 'in-process', reason: 'flag-disabled' };
      },
    );
  });

  it('AC-3 / DoD-1 routes disabled design-doc without worker preparation', async () => {
    await routeDesignDocGenerationKickoff({
      designDocId: 'doc-1',
      userId: 'user-1',
      project: 'proj-alpha',
      threadId: 'thread-design',
      kickoffMessage: 'Generate design.',
    });

    expect(mockRouteBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowClass: 'design-doc',
        userId: 'user-1',
        threadId: 'thread-design',
        prepareWorker: expect.any(Function),
      }),
    );
    expect(mockPrepareBackgroundWorkflowTurn).not.toHaveBeenCalled();
    expect(mockRunGroundingService.getGroundings).not.toHaveBeenCalled();
    expect(mockPropagatePipelineGrounding).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'thread-design',
      'Generate design.',
      undefined,
      [],
      { hidden: true },
    );
  });

  it('AC-0: worker design-doc decision does not call sendMessage', async () => {
    mockRouteBackgroundWorkflow.mockImplementationOnce(async (input) => {
      const prepared = await input.prepareWorker();
      expect(prepared).toEqual(expect.objectContaining({
        prompt: 'complete frozen design prompt',
        targetGrounding: expect.objectContaining({
          runId: 'thread-design',
          repoRole: 'target',
          isActive: true,
        }),
      }));
      return {
        route: 'worker',
        workspacePath: '/pinned',
        runId: 'thread-design',
      };
    });

    await routeDesignDocGenerationKickoff({
      designDocId: 'doc-1',
      userId: 'user-1',
      project: 'proj-alpha',
      threadId: 'thread-design',
      kickoffMessage: 'Generate design.',
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('AC-2 / VT-03 copies source grounding before routing a retry destination', async () => {
    const copiedGrounding = {
      id: 'grounding-retry',
      runType: 'chat',
      runId: 'thread-design',
      project: 'proj-alpha',
      repoRole: 'target',
      provider: 'github',
      repository: 'org/repo',
      branch: 'main',
      groundedSha: 'abc123',
      groundedAt: '2026-08-06T00:00:00.000Z',
      isActive: true,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
    };
    mockRunGroundingService.getGroundings
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([copiedGrounding]);
    mockRouteBackgroundWorkflow.mockImplementationOnce(async (input) => {
      const prepared = await input.prepareWorker();
      expect(prepared.targetGrounding).toEqual(copiedGrounding);
      return {
        route: 'worker',
        workspacePath: '/pinned',
        runId: 'thread-design',
      };
    });

    await routeDesignDocGenerationKickoff({
      designDocId: 'doc-1',
      prdId: 'prd-1',
      sourceThreadId: 'thread-prd',
      userId: 'user-1',
      project: 'proj-alpha',
      threadId: 'thread-design',
      kickoffMessage: 'Generate design.',
    });

    expect(mockPropagatePipelineGrounding).toHaveBeenCalledWith(
      { runType: 'chat', runId: 'thread-prd', project: 'proj-alpha' },
      { runType: 'chat', runId: 'thread-design', project: 'proj-alpha' },
      'user-1',
      { deferMaterialization: true, pinPolicy: 'inherit' },
    );
    expect(mockRouteBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowClass: 'design-doc',
        prepareWorker: expect.any(Function),
      }),
    );
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('cold external project: design-doc preparation failure runs in-process and stays generating', async () => {
    mockRouteBackgroundWorkflow.mockImplementationOnce(
      async (input: { runInProcess(): Promise<void> }) => {
        await input.runInProcess();
        return {
          route: 'in-process',
          reason: 'materialization-unavailable',
          fallbackStarted: true,
        };
      },
    );

    await routeDesignDocGenerationKickoff({
      designDocId: 'doc-1',
      userId: 'user-1',
      project: 'proj-alpha',
      threadId: 'thread-design',
      kickoffMessage: 'Generate design.',
    });

    expect(mockRunGroundingService.persistThenMarkTerminalInactive)
      .not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      'thread-design',
      'Generate design.',
      undefined,
      [],
      { hidden: true },
    );
  });
});

// ── listDesignDocs ─────────────────────────────────────────────────────────────

describe('listDesignDocs', () => {
  beforeEach(() => jest.clearAllMocks());

  /**
   * Helper: builds a mock select chain that supports two consecutive leftJoin calls
   * (one for appUsers, one for prds) before where/orderBy.
   */
  function mockListSelectChain(rows: any[]) {
    const orderByMock = jest.fn().mockResolvedValue(rows);
    const whereMock = jest.fn().mockReturnValue({ orderBy: orderByMock });
    // The chain object is shared across all leftJoin calls so chaining works naturally.
    const chain: any = {};
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.where = whereMock;
    const fromMock = jest.fn().mockReturnValue(chain);
    mockDb.select.mockReturnValue({ from: fromMock });
  }

  it('returns all design docs when no filters are given', async () => {
    mockListSelectChain([{ designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: null }]);

    const result = await listDesignDocs();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'doc-1', status: 'draft' });
  });

  it('returns an empty array when no design docs match', async () => {
    mockListSelectChain([]);

    const result = await listDesignDocs({ userId: 'user-nobody' });

    expect(result).toEqual([]);
  });

  it('returns only design docs linked to the specified prdId', async () => {
    mockListSelectChain([{ designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: 'My PRD' }]);

    const result = await listDesignDocs({ prdId: 'prd-1' });

    expect(result).toHaveLength(1);
    expect(result[0].prdId).toBe('prd-1');
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when no design docs exist for the given project', async () => {
    mockListSelectChain([]);

    const result = await listDesignDocs({ project: 'proj-nonexistent' });

    expect(result).toEqual([]);
  });

  it('includes reviewerName when the reviewer display name is available', async () => {
    mockListSelectChain([
      { designDoc: makeDocRow({ reviewerId: 'reviewer-1' }), reviewerDisplayName: 'Alice', prdTitle: null },
    ]);

    const result = await listDesignDocs();

    expect(result[0].reviewerName).toBe('Alice');
  });

  it('exposes prdTitle on the summary when the joined prd has a title', async () => {
    mockListSelectChain([
      { designDoc: makeDocRow(), reviewerDisplayName: null, prdTitle: 'Payment Service PRD' },
    ]);

    const result = await listDesignDocs();

    expect(result[0].prdTitle).toBe('Payment Service PRD');
  });
});

// ── getDesignDoc ───────────────────────────────────────────────────────────────

describe('getDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a full design doc with all three content fields', async () => {
    const docRow = makeDocRow({ designContent: 'Design', techSpecContent: 'Tech', assumptionsContent: 'Assumptions' });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null, authorDisplayName: null, designDocOwnerId: null, designDocOwnerDisplayName: null }]));

    const result = await getDesignDoc('doc-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('doc-1');
    expect(result!.designContent).toBe('Design');
    expect(result!.techSpecContent).toBe('Tech');
    expect(result!.assumptionsContent).toBe('Assumptions');
  });

  it('returns null when the design doc does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    const result = await getDesignDoc('doc-missing');

    expect(result).toBeNull();
  });

  it('includes reviewerName from the joined appUsers row', async () => {
    const docRow = makeDocRow({ reviewerId: 'reviewer-1' });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: 'Bob', authorDisplayName: null, designDocOwnerId: null, designDocOwnerDisplayName: null }]));

    const result = await getDesignDoc('doc-1');

    expect(result!.reviewerName).toBe('Bob');
  });
});

// ── updateDesignDocContent ─────────────────────────────────────────────────────

describe('updateDesignDocContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates designContent when author edits a draft doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { designContent: 'New design' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ designContent: 'New design' }));
  });

  it('can update techSpecContent and assumptionsContent independently', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { techSpecContent: 'New tech', assumptionsContent: 'New assumptions' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ techSpecContent: 'New tech', assumptionsContent: 'New assumptions' }),
    );
  });

  it('resets status to "draft" and clears review fields when editing a revision_requested doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'revision_requested', reviewerId: 'reviewer-1', reviewComment: 'Fix it' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await updateDesignDocContent('doc-1', 'user-1', { designContent: 'Revised design' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', reviewerId: null }),
    );
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(updateDesignDocContent('doc-missing', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to edit', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(updateDesignDocContent('doc-1', 'user-other', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Only the author or owner can edit design doc content',
    });
  });

  it('throws 409 when trying to edit an approved design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'approved' }));

    await expect(updateDesignDocContent('doc-1', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Approved design docs cannot be edited',
    });
  });

  it('throws 409 when trying to edit a reviewer_approved design doc awaiting owner sign-off', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'reviewer_approved' }));

    await expect(updateDesignDocContent('doc-1', 'user-1', { designContent: 'x' })).rejects.toMatchObject({
      message: 'Approved design docs cannot be edited',
    });
  });
});

// ── submitForReview ────────────────────────────────────────────────────────────

describe('submitForReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a draft design doc to pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 409 when all content fields are empty', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ designContent: '', techSpecContent: '', assumptionsContent: '' }),
    );

    await expect(submitForReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: 'Design doc content must be non-empty before submitting for review',
    });
  });

  it('allows submit when at least one content field is non-empty', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ designContent: 'Has content', techSpecContent: '', assumptionsContent: '' }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  });

  it('allows resubmit when design doc is already pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  });

  it('throws 409 when design doc is already approved', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'approved' }));

    await expect(submitForReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot submit design doc from status 'approved'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(submitForReview('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to submit', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(submitForReview('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can submit for review',
    });
  });

  it('allows the interview design-doc owner to submit', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft', authorId: 'user-author' }));
    mockDb.query.prds.findFirst.mockResolvedValue({ interviewId: 'int-1' });
    mockDb.query.interviews.findFirst.mockResolvedValue({ designDocOwnerId: 'user-owner' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-owner');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  });

  it('calls assignApprovers when approverIds provided', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await submitForReview('doc-1', 'user-1', { approverIds: ['a1', 'a2'] });

    expect(mockAssignApprovers).toHaveBeenCalledWith('doc-1', 'design_doc', ['a1', 'a2'], 'user-1');
  });
});

// ── withdrawFromReview ─────────────────────────────────────────────────────────

describe('withdrawFromReview', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions a pending_review design doc back to draft', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await withdrawFromReview('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('throws 409 when design doc is not in pending_review status', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));

    await expect(withdrawFromReview('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot withdraw design doc from status 'draft'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(withdrawFromReview('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to withdraw', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review' }));

    await expect(withdrawFromReview('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can withdraw from review',
    });
  });
});

// ── reviewDesignDoc ────────────────────────────────────────────────────────────

describe('reviewDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingDoc = makeDocRow({ status: 'pending_review', authorId: 'user-author' });

  it('transitions a pending_review design doc to reviewer_approved (owner approval is separate)', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
    expect(setMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('throws 400 for invalid review action', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'request_revision' } as any),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Invalid review action'),
      status: 400,
    });
  });

  it('throws 403 when the author tries to review their own design doc', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);

    await expect(
      reviewDesignDoc('doc-1', 'user-author', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You cannot review your own design doc',
      status: 403,
    });
  });

  it('throws 409 when design doc is not in pending_review status', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft', authorId: 'user-author' }));

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("Cannot review design doc from status 'draft'"),
    });
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(
      reviewDesignDoc('doc-missing', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({ message: 'Design doc not found' });
  });

  it('throws 403 when reviewer is not assigned and not admin', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(false);

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: 'You are not an assigned approver for this design doc',
      status: 403,
    });
  });

  it('allows admin to review even if not assigned', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved' }),
    );
  });

  it('gates approval transition on isApprovalComplete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── deleteDesignDoc ────────────────────────────────────────────────────────────

describe('deleteDesignDoc', () => {
  beforeEach(() => jest.clearAllMocks());

  it('deletes the design doc when the requesting user is the author', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteDesignDoc('doc-1', 'user-1');

    expect(mockCancelRun).toHaveBeenCalledWith('thread-1');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(whereMock).toHaveBeenCalledTimes(1);
  });

  it('cancels every linked active-work thread before deleting', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({
      chatThreadId: 'thread-generation',
      validationThreadId: 'thread-validation',
      docAssistantThreadId: 'thread-assistant',
    }));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    mockDb.delete.mockReturnValue({ where: whereMock });

    await deleteDesignDoc('doc-1', 'user-1');

    expect(mockCancelRun).toHaveBeenCalledTimes(3);
    expect(mockCancelRun).toHaveBeenCalledWith('thread-generation');
    expect(mockCancelRun).toHaveBeenCalledWith('thread-validation');
    expect(mockCancelRun).toHaveBeenCalledWith('thread-assistant');
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(deleteDesignDoc('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
    });
  });

  it('throws 403 when a non-author tries to delete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());

    await expect(deleteDesignDoc('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can delete this design doc',
    });
    expect(mockDb.delete).not.toHaveBeenCalled();
  });
});

// ── syncDesignDocContent ───────────────────────────────────────────────────────

describe('syncDesignDocContent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('updates designContent when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Generated design' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ designContent: 'Generated design' }),
    );
  });

  it('sets finalStatus to pending_review when all three content fields are synced', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', {
      designContent: 'Design',
      techSpecContent: 'Tech',
      assumptionsContent: 'Assumptions',
      finalStatus: 'pending_review',
    });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('does not set status when finalStatus is not provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Partial content' });

    const callArg = setMock.mock.calls[0][0];
    expect(callArg).not.toHaveProperty('status');
  });

  it('accepts a custom final status', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { finalStatus: 'draft' });

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('can sync techSpecContent and assumptionsContent independently', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { techSpecContent: 'Tech spec', assumptionsContent: 'Assumptions' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ techSpecContent: 'Tech spec', assumptionsContent: 'Assumptions' }),
    );
  });
});

// ── syncValidationResult ──────────────────────────────────────────────────────

describe('syncValidationResult', () => {
  beforeEach(() => jest.clearAllMocks());

  /** Minimal valid scorecard — generateFallbackReport requires verdict + features. */
  function makeScorecardFixture(overrides: Partial<Record<string, any>> = {}) {
    return {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'initial',
      overall_score: 85,
      ready_threshold: 90,
      is_ready: false,
      verdict: 'gaps',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
      ...overrides,
    };
  }

  it('sets validationScore, validationScorecard, and validationPhase from the scorecard', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 85, review_phase: 'initial' });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        validationScore: 85,
        validationScorecard: scorecard,
        validationPhase: 'initial',
      }),
    );
  });

  it('sets status to pending_review after validation completes (ready scorecard)', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 95, is_ready: true, review_phase: 'final', verdict: 'ready' });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('sets status to pending_review after validation completes (gaps remain)', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 70, is_ready: false });

    await syncValidationResult('doc-1', scorecard as any);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('persists validationReportMd when provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 92, is_ready: true, verdict: 'ready', review_phase: 'final' });

    await syncValidationResult('doc-1', scorecard as any, '## Validation Report\nAll good.');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ validationReportMd: '## Validation Report\nAll good.' }),
    );
  });

  it('generates a fallback markdown report when none is provided', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = makeScorecardFixture({ overall_score: 80, is_ready: false });

    await syncValidationResult('doc-1', scorecard as any);

    const callArg = setMock.mock.calls[0][0];
    expect(typeof callArg.validationReportMd).toBe('string');
    expect(callArg.validationReportMd).toContain('Validation Report');
  });
});

// ── markValidationReady ───────────────────────────────────────────────────────

describe('markValidationReady', () => {
  beforeEach(() => jest.clearAllMocks());

  it('transitions to pending_review when status is validating and score >= 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markValidationReady('doc-1', 'user-1');

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('throws 404 when design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(markValidationReady('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
      status: 404,
    });
  });

  it('throws 403 when a non-author/non-admin tries to mark ready', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );

    await expect(markValidationReady('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author or owner can mark validation as ready',
      status: 403,
    });
  });

  it('throws 409 when status is not validating', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'draft', validationScore: 95 }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot mark ready from status 'draft'"),
      status: 409,
    });
  });

  it('throws 409 when validation score is below 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 75 }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });

  it('throws 409 when validation score is null', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: null }),
    );

    await expect(markValidationReady('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });
});

// ── reviewDesignDoc (approve with validation gate) ────────────────────────────

describe('reviewDesignDoc (approve with validation gate)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 409 when validation is configured and score is below the project threshold', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: 60 }),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      designDocValidationScoreThreshold: 80,
    });

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 80'),
      status: 409,
    });
  });

  it('throws 409 when validation is configured and score is below 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: 50 }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Validation score must be >= 90'),
      status: 409,
    });
  });

  it('throws 409 when validation is configured and score is null', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: null }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });

    await expect(
      reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not scored'),
      status: 409,
    });
  });

  it('allows approve when validation is configured and score >= 90', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', authorId: 'user-author', validationScore: 92 }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('allows approve below threshold when a validation override is recorded', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({
        status: 'pending_review',
        authorId: 'user-author',
        validationScore: 55,
        validationOverride: {
          reason: 'Accepted residual risk',
          userId: 'user-admin',
          userDisplayName: 'Admin',
          at: '2026-07-26T12:00:00.000Z',
          validationScore: 55,
          validationThreshold: 90,
          history: [
            {
              reason: 'Accepted residual risk',
              userId: 'user-admin',
              userDisplayName: 'Admin',
              at: '2026-07-26T12:00:00.000Z',
              summary: 'Overrode validation score 55% (threshold 90%)',
            },
          ],
        },
      }),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
  });
});

describe('overrideDesignDocValidation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores an audited override with history', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'pending_review', validationScore: 40 }),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      designDocValidationScoreThreshold: 90,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const override = await overrideDesignDocValidation('doc-1', 'user-1', 'Need to ship', 'Ada');

    expect(override.reason).toBe('Need to ship');
    expect(override.userDisplayName).toBe('Ada');
    expect(override.history).toHaveLength(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        validationOverride: expect.objectContaining({
          reason: 'Need to ship',
          history: expect.arrayContaining([
            expect.objectContaining({ reason: 'Need to ship', summary: expect.stringContaining('40%') }),
          ]),
        }),
      }),
    );
  });

  it('requires a reason', async () => {
    await expect(overrideDesignDocValidation('doc-1', 'user-1', '   ')).rejects.toMatchObject({
      message: expect.stringContaining('reason is required'),
      status: 400,
    });
  });
});

// ── startDesignDocWatcher ─────────────────────────────────────────────────────

describe('startDesignDocWatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets design doc to draft when watcher times out without finding features', async () => {
    const { readAllOutputDesignDocFeatures: mockReadFeatures } =
      jest.requireMock('../services/chatAgentService') as { readAllOutputDesignDocFeatures: jest.Mock };
    mockReadFeatures.mockReturnValue([]);

    // The watcher queries the seed doc on each tick to check if syncOutputToDb already handled it
    mockDb.query.designDocs.findFirst.mockResolvedValue({
      id: 'doc-seed',
      chatThreadId: 'thread-dd',
      prdId: 'prd-1',
      project: 'proj-alpha',
      authorId: 'user-1',
    });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startDesignDocWatcher('doc-seed', 'thread-dd');

    // Max attempts = 360, advance past all ticks + 1
    for (let i = 0; i <= 360; i++) {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });
});

// ── startSingleFeatureDocWatcher — cross-instance liveness ────────────────────

describe('startSingleFeatureDocWatcher', () => {
  const { isThreadIdle: mockIsThreadIdle } =
    jest.requireMock('../services/chatAgentService') as { isThreadIdle: jest.Mock };

  function runRow(status: string) {
    return {
      status,
      ownerInstance: null,
      updatedAt: '2026-08-06T00:00:00.000Z',
      timeoutAt: null,
    };
  }
  const {
    readOutputDesignDoc: mockDesign,
    readOutputTechSpec: mockTech,
    readOutputAssumptions: mockAssumptions,
  } = jest.requireMock('../services/chatAgentService') as {
    readOutputDesignDoc: jest.Mock;
    readOutputTechSpec: jest.Mock;
    readOutputAssumptions: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockDesign.mockReturnValue(null);
    mockTech.mockReturnValue(null);
    mockAssumptions.mockReturnValue(null);
    mockIsThreadIdle.mockReturnValue(true);
    mockLegacyCanFail.mockResolvedValue(true);
    mockLegacyLatestRun.mockResolvedValue(null);
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: null,
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: false,
    });
    mockTryAcquireRepoCacheLease.mockResolvedValue(makeHeldLease());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // The fail path awaits the doc guard, the run's terminal reason, and the
  // grounding write before the status update lands, so counting hops by hand
  // breaks whenever one more await joins the chain.
  async function flushPendingWork(): Promise<void> {
    for (let hop = 0; hop < 10; hop += 1) {
      await Promise.resolve();
    }
  }

  it('starts only one timer when two simulated processes contend for one watcher lease', async () => {
    const lease = makeHeldLease();
    mockTryAcquireRepoCacheLease
      .mockResolvedValueOnce(lease)
      .mockResolvedValueOnce(null);
    const timeoutSpy = jest.spyOn(global, 'setTimeout');

    let processA: typeof import('../services/designDocService');
    let processB: typeof import('../services/designDocService');
    await jest.isolateModulesAsync(async () => {
      processA = await import('../services/designDocService');
    });
    await jest.isolateModulesAsync(async () => {
      processB = await import('../services/designDocService');
    });

    const [startedA, startedB] = await Promise.all([
      processA!.tryStartSingleFeatureDocWatcher('doc-lease', 'thread-lease', 'prd-1', 'proj-alpha'),
      processB!.tryStartSingleFeatureDocWatcher('doc-lease', 'thread-lease', 'prd-1', 'proj-alpha'),
    ]);

    expect(startedA).toBe(true);
    expect(startedB).toBe(false);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);

    lease.controller.abort(new Error('cleanup'));
    await flushPendingWork();
    timeoutSpy.mockRestore();
  });

  it('returns false without hydration or timer creation when another owner holds the lease', async () => {
    mockTryAcquireRepoCacheLease.mockResolvedValueOnce(null);
    const intervalSpy = jest.spyOn(global, 'setInterval');

    await expect(
      tryStartSingleFeatureDocWatcher('doc-held', 'thread-held', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(false);

    expect(mockHydrateThread).not.toHaveBeenCalled();
    expect(intervalSpy).not.toHaveBeenCalled();
    intervalSpy.mockRestore();
  });

  it('releases the lease and reports start failure when hydration rejects', async () => {
    const lease = makeHeldLease();
    mockTryAcquireRepoCacheLease.mockResolvedValueOnce(lease);
    mockHydrateThread.mockRejectedValueOnce(new Error('hydrate failed'));

    await expect(
      tryStartSingleFeatureDocWatcher('doc-hydrate-error', 'thread-hydrate-error', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(false);

    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it('stops the local timer on lease loss without finalizing or failing the document', async () => {
    const lease = makeHeldLease();
    mockTryAcquireRepoCacheLease.mockResolvedValueOnce(lease);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-lease-loss', 'thread-lease-loss', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    expect(isDocWatcherActive('doc-lease-loss')).toBe(true);

    lease.controller.abort(new Error('lost lease'));
    await flushPendingWork();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(isDocWatcherActive('doc-lease-loss')).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
    expect(mockDb.query.chatThreads.findFirst).not.toHaveBeenCalled();
  });

  it('does not mutate or clean up when lease ownership is lost before finalization', async () => {
    const lease = makeHeldLease();
    lease.assertOwned.mockRejectedValueOnce(new Error('lease lost'));
    mockTryAcquireRepoCacheLease.mockResolvedValueOnce(lease);
    mockDesign.mockReturnValue('# design');
    mockTech.mockReturnValue('# tech spec');
    mockAssumptions.mockReturnValue('# assumptions');
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-lease-fence', 'thread-lease-fence', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(lease.assertOwned).toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
    expect(mockDb.query.chatThreads.findFirst).not.toHaveBeenCalled();
  });

  it('does not fail generation while agent_runs says the run is still alive', async () => {
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: true,
      canFailGeneration: false,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-live', 'thread-live', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(mockThreadRunStateSnapshot).toHaveBeenCalledWith('thread-live');
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('fails generation when the thread is idle, run is dead, and this instance owned it', async () => {
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'failed', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-fail', 'thread-fail', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('saves output the recovery sweep cleared while the watcher was waiting to write', async () => {
    // Production sequence: all three files present at 18:43:55, gone at
    // 18:44:09, generation_failed at 18:44:11 despite the agent succeeding.
    mockDesign.mockReturnValue('# design');
    mockTech.mockReturnValue('# tech spec');
    mockAssumptions.mockReturnValue('# assumptions');
    mockThreadRunStateSnapshot
      .mockResolvedValueOnce({
        latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: true,
        canFailGeneration: false,
      })
      .mockResolvedValueOnce({
        latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:05.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: false,
        canFailGeneration: true,
      });
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-snapshot', 'thread-snapshot', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    // Tick one: complete output, but the run still looks alive so the watcher
    // declines to write. This is where the content has to be captured.
    jest.advanceTimersByTime(5_000);
    await flushPendingWork();
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );

    // The sweep clears the workspace, then the run goes terminal.
    mockDesign.mockReturnValue(null);
    mockTech.mockReturnValue(null);
    mockAssumptions.mockReturnValue(null);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    const written = setMock.mock.calls
      .map(([values]) => values as Record<string, unknown>)
      .find((values) => values.designContent !== undefined);
    expect(written).toBeDefined();
    expect(written?.designContent).toBe('# design');
    expect(written?.techSpecContent).toBe('# tech spec');
    expect(written?.assumptionsContent).toBe('# assumptions');
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('blames the dispatch, not the agent, when the run never reached a worker', async () => {
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'failed', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    mockDb.query.agentRuns.findFirst.mockResolvedValue({ terminalReason: 'dispatch_ttl' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-dispatch', 'thread-dispatch', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    const recorded = setMock.mock.calls
      .map(([values]) => values as { status?: string; generationError?: string })
      .find((values) => values.status === 'generation_failed');
    expect(recorded?.generationError).toContain('Dispatch never reached a worker');
    expect(recorded?.generationError).toContain('dispatch_ttl');
    expect(recorded?.generationError).not.toContain('Missing output files');
  });

  it('keeps polling when canFail is false (does not abandon the watcher)', async () => {
    mockThreadRunStateSnapshot
      .mockResolvedValueOnce({
        latestRun: { status: 'completed', ownerInstance: 'worker-b', updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: false,
        canFailGeneration: false,
      })
      .mockResolvedValueOnce({
        latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:02:30.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: false,
        canFailGeneration: true,
      });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-grace', 'thread-grace', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    // First tick: not allowed to fail yet — must not mark failed and must keep watching
    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );

    // Later tick: orphan grace / ownership allows fail — watcher must still be alive
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('times out on the original deadline even while recovery keeps restarting the watcher', async () => {
    // Regression: the tick counter restarted from zero on every recovery
    // restart, so the timeout was unreachable and docs stayed in `generating`.
    mockIsThreadIdle.mockReturnValue(false);
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: true,
      canFailGeneration: false,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-deadline', 'thread-deadline', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    // Restart on the one-minute cadence startup recovery uses.
    for (let minute = 0; minute < 31; minute += 1) {
      await jest.advanceTimersByTimeAsync(60_000);
      startSingleFeatureDocWatcher('doc-deadline', 'thread-deadline', 'prd-1', 'proj-alpha');
    }
    await jest.advanceTimersByTimeAsync(5_000);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generation_failed',
        generationError: 'Generation timed out',
      }),
    );
  });

  it('does not spend the budget while the doc is still waiting for a worker', async () => {
    // Approving a PRD submits more docs than the lane runs at once, so a doc can
    // wait longer than it takes to generate. Charging that wait to the agent
    // expired docs no worker had opened yet.
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: { status: 'queued', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: false,
      isAlive: true,
      canFailGeneration: false,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-queued', 'thread-queued', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    // Twice the whole budget, every tick of it spent queued.
    await jest.advanceTimersByTimeAsync(60 * 60_000);

    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('gives the agent the full budget once a worker picks the doc up', async () => {
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: { status: 'queued', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: false,
      isAlive: true,
      canFailGeneration: false,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-late', 'thread-late', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    // A full budget's worth of queue wait costs the agent nothing.
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );

    // Only now does the clock start, and it runs for the whole budget.
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:30:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: true,
      canFailGeneration: false,
    });
    await jest.advanceTimersByTimeAsync(30 * 60_000 - 10_000);
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );

    await jest.advanceTimersByTimeAsync(10_000);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generation_failed',
        generationError: 'Generation timed out',
      }),
    );
  });

  it('does not fail on first tick when no agent_runs row exists yet (kickoff in progress)', async () => {
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: null,
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: false,
    });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-starting', 'thread-starting', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(mockThreadRunStateSnapshot).toHaveBeenCalledWith('thread-starting');
    expect(setMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });

  it('does not finalize success while output files exist but the run is still alive', async () => {
    mockDesign.mockReturnValue('# Design');
    mockTech.mockReturnValue('# Tech');
    mockAssumptions.mockReturnValue('# Assumptions');
    mockIsThreadIdle.mockReturnValue(true);
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: true,
      canFailGeneration: false,
    });

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-output-live', 'thread-output-live', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(mockThreadRunStateSnapshot).toHaveBeenCalledWith('thread-output-live');
    expect(setMock).not.toHaveBeenCalled();
  });

  it('finalizes success when output files exist and the run is finished', async () => {
    mockDesign.mockReturnValue('# Design');
    mockTech.mockReturnValue('# Tech');
    mockAssumptions.mockReturnValue('# Assumptions');
    mockIsThreadIdle.mockReturnValue(true);
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    mockDb.query.designDocs.findFirst.mockResolvedValue({
      id: 'doc-1',
      status: 'generating',
      chatThreadId: 'thread-1',
      skillSettingsId: null,
    });
    mockGetSkillConfig.mockResolvedValue(null);

    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-success', 'thread-success', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(5_000);
    await flushPendingWork();

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        designContent: '# Design',
        techSpecContent: '# Tech',
        assumptionsContent: '# Assumptions',
      }),
    );
  });

  it('does not overlap ticks while run-state lookup is still pending', async () => {
    let resolveState: ((value: unknown) => void) | null = null;
    const pendingState = new Promise((resolve) => {
      resolveState = resolve;
    });
    mockThreadRunStateSnapshot.mockReturnValueOnce(pendingState);

    await expect(
      tryStartSingleFeatureDocWatcher('doc-overlap', 'thread-overlap', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(1);

    resolveState?.({
      latestRun: null,
      shouldChargeWorkBudget: false,
      isAlive: false,
      canFailGeneration: false,
    });
    await flushPendingWork();
  });

  it('captures output before a run-state lookup failure so the next tick can still persist it', async () => {
    mockDesign.mockReturnValue('# design');
    mockTech.mockReturnValue('# tech spec');
    mockAssumptions.mockReturnValue('# assumptions');
    mockThreadRunStateSnapshot
      .mockRejectedValueOnce(new Error('run state unavailable'))
      .mockResolvedValueOnce({
        latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:05.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: false,
        canFailGeneration: true,
      });
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-pre-capture', 'thread-pre-capture', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    await jest.advanceTimersByTimeAsync(5_000);
    mockDesign.mockReturnValue(null);
    mockTech.mockReturnValue(null);
    mockAssumptions.mockReturnValue(null);

    await jest.advanceTimersByTimeAsync(5_000);
    await flushPendingWork();

    const written = setMock.mock.calls
      .map(([values]) => values as Record<string, unknown>)
      .find((values) => values.designContent !== undefined);
    expect(written).toBeDefined();
    expect(written?.designContent).toBe('# design');
    expect(written?.techSpecContent).toBe('# tech spec');
    expect(written?.assumptionsContent).toBe('# assumptions');
  });

  it('uses one consolidated run-state helper call per executed tick', async () => {
    mockThreadRunStateSnapshot.mockResolvedValueOnce({
      latestRun: { status: 'queued', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: false,
      isAlive: true,
      canFailGeneration: false,
    });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-one-read', 'thread-one-read', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(1);
    expect(mockLegacyIsThreadRunAlive).not.toHaveBeenCalled();
    expect(mockLegacyCanFail).not.toHaveBeenCalled();
    expect(mockLegacyLatestRun).not.toHaveBeenCalled();
  });

  it('catches a rejected run-state read and does not finalize or clean workspace', async () => {
    mockThreadRunStateSnapshot.mockRejectedValueOnce(new Error('run state unavailable'));
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };

    await expect(
      tryStartSingleFeatureDocWatcher('doc-read-error', 'thread-read-error', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);

    expect(setMock).not.toHaveBeenCalled();
    expect(mockDb.query.chatThreads.findFirst).not.toHaveBeenCalled();
  });

  it('resets the bounded error backoff after a successful tick', async () => {
    mockThreadRunStateSnapshot
      .mockRejectedValueOnce(new Error('first read failed'))
      .mockRejectedValueOnce(new Error('second read failed'))
      .mockResolvedValueOnce({
        latestRun: { status: 'queued', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
        shouldChargeWorkBudget: false,
        isAlive: true,
        canFailGeneration: false,
      })
      .mockRejectedValueOnce(new Error('third read failed'));

    await expect(
      tryStartSingleFeatureDocWatcher('doc-backoff', 'thread-backoff', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledTimes(4);
  });

  it('backs off downstream finalization failures instead of resetting after the run-state read', async () => {
    mockDesign.mockReturnValue('# Design');
    mockTech.mockReturnValue('# Tech');
    mockAssumptions.mockReturnValue('# Assumptions');
    mockThreadRunStateSnapshot.mockResolvedValue({
      latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:00.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    mockDb.query.designDocs.findFirst
      .mockRejectedValueOnce(new Error('db unavailable'))
      .mockRejectedValueOnce(new Error('db unavailable again'))
      .mockResolvedValue({ id: 'doc-1', status: 'generating', chatThreadId: 'thread-downstream', skillSettingsId: null });
    mockDb.query.chatThreads = { findFirst: jest.fn().mockResolvedValue(null) };
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-downstream', 'thread-downstream', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockDb.query.designDocs.findFirst).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockDb.query.designDocs.findFirst).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(mockDb.query.designDocs.findFirst).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        designContent: '# Design',
        techSpecContent: '# Tech',
        assumptionsContent: '# Assumptions',
      }),
    );
  });

  it('does not let a stale tick stop or release a replacement watcher', async () => {
    const leaseA = makeHeldLease();
    const leaseB = makeHeldLease();
    let resolveA: ((value: unknown) => void) | null = null;
    const pendingA = new Promise((resolve) => {
      resolveA = resolve;
    });
    mockTryAcquireRepoCacheLease
      .mockResolvedValueOnce(leaseA)
      .mockResolvedValueOnce(leaseB);
    mockThreadRunStateSnapshot
      .mockReturnValueOnce(pendingA)
      .mockResolvedValueOnce({
        latestRun: { status: 'running', ownerInstance: null, updatedAt: '2026-08-06T00:00:05.000Z', timeoutAt: null },
        shouldChargeWorkBudget: true,
        isAlive: true,
        canFailGeneration: false,
      });

    await expect(
      tryStartSingleFeatureDocWatcher('doc-replace', 'thread-old', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    await jest.advanceTimersByTimeAsync(5_000);

    await expect(
      tryStartSingleFeatureDocWatcher('doc-replace', 'thread-new', 'prd-1', 'proj-alpha'),
    ).resolves.toBe(true);
    await flushPendingWork();

    resolveA?.({
      latestRun: { status: 'completed', ownerInstance: null, updatedAt: '2026-08-06T00:00:10.000Z', timeoutAt: null },
      shouldChargeWorkBudget: true,
      isAlive: false,
      canFailGeneration: true,
    });
    await flushPendingWork();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(isDocWatcherActive('doc-replace')).toBe(true);
    expect(mockThreadRunStateSnapshot).toHaveBeenCalledWith('thread-new');
    expect(leaseB.release).not.toHaveBeenCalled();
  });
});

describe('startValidationWatcher', () => {
  const {
    readOutputValidationScorecard: mockScorecard,
    isThreadIdle: mockIsThreadIdle,
    isOutputWorkspaceReadable: mockReadable,
  } = jest.requireMock('../services/chatAgentService') as {
    readOutputValidationScorecard: jest.Mock;
    isThreadIdle: jest.Mock;
    isOutputWorkspaceReadable: jest.Mock;
  };
  const {
    isThreadRunAlive: mockIsThreadRunAlive,
    canThisInstanceFailGeneration: mockCanFail,
  } = jest.requireMock('../services/agentRunReaperService') as {
    isThreadRunAlive: jest.Mock;
    canThisInstanceFailGeneration: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockScorecard.mockReturnValue(null);
    mockIsThreadIdle.mockReturnValue(true);
    mockIsThreadRunAlive.mockResolvedValue(false);
    mockCanFail.mockResolvedValue(true);
    mockReadable.mockReturnValue(true);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('waits rather than blaming the agent when the workspace cannot be read', async () => {
    // A thread that has not hydrated has no workspace, so the scorecard read
    // returns null for the same reason whether or not the agent wrote one.
    mockReadable.mockReturnValue(false);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startValidationWatcher('doc-unreadable', 'thread-unreadable');
    await jest.advanceTimersByTimeAsync(60_000);

    expect(setMock).not.toHaveBeenCalled();
  });

  it('records the missing scorecard once the workspace is readable', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    startValidationWatcher('doc-noscorecard', 'thread-noscorecard');
    await jest.advanceTimersByTimeAsync(5_000);

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'pending_review',
        validationScorecard: expect.anything(),
      }),
    );
  });
});

// ── Notification on pending_review transition ─────────────────────────────────

describe('notifyApproversDocumentReady integration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('markValidationReady notifies approvers when transitioning to pending_review', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationScore: 95 }),
    );
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await markValidationReady('doc-1', 'user-1');

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncValidationResult notifies approvers when scorecard.is_ready is true', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'final',
      overall_score: 95,
      ready_threshold: 90,
      is_ready: true,
      verdict: 'ready',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
    };

    await syncValidationResult('doc-1', scorecard as any);

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncValidationResult notifies approvers when validation transitions to pending_review', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const scorecard = {
      slug: 'feature-a',
      generated_at: '2026-01-01T00:00:00Z',
      review_phase: 'initial',
      overall_score: 70,
      ready_threshold: 90,
      is_ready: false,
      verdict: 'gaps',
      features: [],
      cross_cutting_checks: {},
      accepted_gaps: [],
      deferred_gaps: [],
    };

    await syncValidationResult('doc-1', scorecard as any);

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncDesignDocContent notifies approvers when finalStatus is pending_review', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', {
      designContent: 'Design',
      techSpecContent: 'Tech',
      assumptionsContent: 'Assumptions',
      finalStatus: 'pending_review',
    });

    expect(mockNotifyApproversDocumentReady).toHaveBeenCalledWith('doc-1', 'design_doc');
  });

  it('syncDesignDocContent does NOT notify approvers when finalStatus is draft', async () => {
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await syncDesignDocContent('doc-1', { designContent: 'Content', finalStatus: 'draft' });

    expect(mockNotifyApproversDocumentReady).not.toHaveBeenCalled();
  });
});

// ── reviewDesignDoc (admin override & designated approver) ────────────────────

describe('reviewDesignDoc (admin override & designated approver)', () => {
  beforeEach(() => jest.clearAllMocks());

  const pendingDocWithValidation = makeDocRow({
    status: 'pending_review',
    authorId: 'user-author',
    validationScore: 95,
  });

  it('admin approval bypasses isApprovalComplete check entirely', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockIsAssignedApprover.mockResolvedValue(false);
    mockIsAdminUser.mockResolvedValue(true);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-admin', { action: 'approve' });

    expect(mockIsApprovalComplete).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved' }),
    );
  });

  it('designated approver with green validation transitions to reviewer_approved', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: '/skills/validate.md' });
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reviewer_approved', reviewerId: 'user-reviewer' }),
    );
  });

  it('designated approver stays pending_review when all_required mode not fully met', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDocWithValidation);
    mockGetSkillConfig.mockResolvedValue(null);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── Two-stage design doc approval workflow ────────────────────────────────────

describe('two-stage design doc approval workflow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reviewer approval leaves doc in reviewer_approved until owner acts', async () => {
    const pendingDoc = makeDocRow({ status: 'pending_review', authorId: 'user-author' });
    mockDb.query.designDocs.findFirst.mockResolvedValue(pendingDoc);
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsApprovalComplete.mockResolvedValue({ complete: true, mode: 'any_one' });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalledWith('doc-1', 'design_doc', 'user-reviewer', 'approved');
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'reviewer_approved' }));
    expect(setMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
  });

  it('records partial reviewer response without status change when quorum is incomplete', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'pending_review', authorId: 'user-author' }));
    mockIsAssignedApprover.mockResolvedValue(true);
    mockIsAdminUser.mockResolvedValue(false);
    mockIsApprovalComplete.mockResolvedValue({ complete: false, mode: 'all_required' });

    await reviewDesignDoc('doc-1', 'user-reviewer', { action: 'approve' });

    expect(mockRecordApproverResponse).toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

// ── startSingleFeatureDesignDocWatcher — routing context injection ─────────────

describe('startSingleFeatureDesignDocWatcher — routing context injection', () => {
  const { createThread: mockCreateThread } = jest.requireMock('../services/chatAgentService') as { createThread: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setupCommonMocks() {
    // No existing doc — proceed with generation.
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    mockDb.query.prds.findFirst.mockResolvedValue({
      id: 'prd-1',
      project: 'proj-alpha',
      authorId: 'user-1',
      content: 'PRD content',
      backlogJson: {
        features: [
          { id: 'feat-0', title: 'Feature 0' },
          { id: 'feat-1', title: 'Feature 1', route: '/existing-page' },
        ],
      },
      interviewId: null,
      skillSettingsId: null,
    });

    mockDb.query.designPrototypes.findFirst.mockResolvedValue({
      featureName: 'My Feature',
      mockHtml: null,
      mockVersion: 1,
    });

    // Default: no design plan row.
    mockDb.query.designPlans.findFirst.mockResolvedValue(null);

    // insert().values().returning() → return a design doc id.
    const returningMock = jest.fn().mockResolvedValue([{ id: 'doc-new' }]);
    const valuesMock = jest.fn().mockReturnValue({ returning: returningMock });
    mockDb.insert.mockReturnValue({ values: valuesMock });

    // update().set().where()
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    mockCreateThread.mockResolvedValue({ id: 'thread-new', kickoff: {} });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    setupCommonMocks();
  });

  it('injects decision and targetRoute from the design plan into the generation context', async () => {
    mockDb.query.designPlans.findFirst.mockResolvedValue({
      features: [{ featureIndex: 0, decision: 'new-page', targetRoute: '/shift-scheduler' }],
    });

    await startSingleFeatureDesignDocWatcher('proto-1', 0, 'prd-1', null);

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    const { freeformContext } = mockCreateThread.mock.calls[0][1];
    expect(freeformContext).toContain('Decision: new-page');
    expect(freeformContext).toContain('Target route: /shift-scheduler');
    expect(freeformContext).toContain('## Target route');
    expect(freeformContext).toContain('`/shift-scheduler`');
    expect(freeformContext).toContain('## Page decision');
    expect(freeformContext).toContain('`new-page`');
  });

  it('falls back to backlog feature.route when design plan targetRoute is absent', async () => {
    mockDb.query.designPlans.findFirst.mockResolvedValue({
      features: [{ featureIndex: 1, decision: 'update-page' }],
    });

    await startSingleFeatureDesignDocWatcher('proto-1', 1, 'prd-1', null);

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    const { freeformContext } = mockCreateThread.mock.calls[0][1];
    expect(freeformContext).toContain('Decision: update-page');
    expect(freeformContext).toContain('Target route: /existing-page');
    expect(freeformContext).toContain('`/existing-page`');
  });

  it('emits N/A for targetRoute and still emits both headings when decision is no-ui', async () => {
    mockDb.query.designPlans.findFirst.mockResolvedValue({
      features: [{ featureIndex: 0, decision: 'no-ui', targetRoute: '/irrelevant' }],
    });

    await startSingleFeatureDesignDocWatcher('proto-1', 0, 'prd-1', null);

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    const { freeformContext } = mockCreateThread.mock.calls[0][1];
    expect(freeformContext).toContain('Decision: no-ui');
    expect(freeformContext).toContain('Target route: N/A');
    expect(freeformContext).toContain('`N/A`');
    expect(freeformContext).toContain('`no-ui`');
  });

  it('defaults to new-page and N/A when no design plan exists', async () => {
    mockDb.query.designPlans.findFirst.mockResolvedValue(null);

    await startSingleFeatureDesignDocWatcher('proto-1', 0, 'prd-1', null);

    expect(mockCreateThread).toHaveBeenCalledTimes(1);
    const { freeformContext } = mockCreateThread.mock.calls[0][1];
    expect(freeformContext).toContain('Decision: new-page');
    expect(freeformContext).toContain('Target route: N/A');
  });

  it('does not call createThread when the doc already exists and is not generation_failed', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-existing', status: 'generating' });

    await startSingleFeatureDesignDocWatcher('proto-1', 0, 'prd-1', null);

    expect(mockCreateThread).not.toHaveBeenCalled();
  });

  it('does not call createThread when the doc exists with generation_failed (retry via route)', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-failed', status: 'generation_failed' });

    await startSingleFeatureDesignDocWatcher('proto-1', 0, 'prd-1', null);

    expect(mockCreateThread).not.toHaveBeenCalled();
  });
});

// ── finalizeSingleFeatureDoc — idempotency guard ───────────────────────────────

describe('finalizeSingleFeatureDoc — idempotency guard', () => {
  const { readOutputDesignDoc: mockDesign, readOutputTechSpec: mockTech, readOutputAssumptions: mockAssumptions } =
    jest.requireMock('../services/chatAgentService') as {
      readOutputDesignDoc: jest.Mock;
      readOutputTechSpec: jest.Mock;
      readOutputAssumptions: jest.Mock;
    };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDesign.mockReturnValue('# Design');
    mockTech.mockReturnValue('# Tech');
    mockAssumptions.mockReturnValue('# Assumptions');
  });

  it('returns false without updating when thread guard fails (already finalized)', async () => {
    // Row no longer owns the thread — guard fails
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await finalizeSingleFeatureDoc('doc-1', 'thread-old', 'proj-alpha');

    expect(result).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('returns true and writes content when all three output files are present', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await finalizeSingleFeatureDoc('doc-1', 'thread-1', 'proj-alpha');

    expect(result).toBe(true);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ designContent: '# Design', techSpecContent: '# Tech', assumptionsContent: '# Assumptions' }),
    );
  });

  it('returns false and marks generation_failed when output files are missing', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ id: 'doc-1', skillSettingsId: null });
    mockDesign.mockReturnValue(null);
    const whereMock = jest.fn().mockResolvedValue(undefined);
    const setMock = jest.fn().mockReturnValue({ where: whereMock });
    mockDb.update.mockReturnValue({ set: setMock });

    const result = await finalizeSingleFeatureDoc('doc-1', 'thread-1', 'proj-alpha');

    expect(result).toBe(false);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'generation_failed' }),
    );
  });
});

// ── isSingleFeatureDesignDocRow ────────────────────────────────────────────────

describe('isSingleFeatureDesignDocRow', () => {
  it('is true for prototype-linked docs', () => {
    expect(isSingleFeatureDesignDocRow({ designPrototypeId: 'proto-1', featureIndex: 0 })).toBe(true);
  });

  it('is true for PRD-spawned per-feature docs (featureIndex only)', () => {
    expect(isSingleFeatureDesignDocRow({ designPrototypeId: null, featureIndex: 2 })).toBe(true);
  });

  it('is false for legacy multi-feature seeds (neither set)', () => {
    expect(isSingleFeatureDesignDocRow({ designPrototypeId: null, featureIndex: null })).toBe(false);
    expect(isSingleFeatureDesignDocRow({})).toBe(false);
  });
});
