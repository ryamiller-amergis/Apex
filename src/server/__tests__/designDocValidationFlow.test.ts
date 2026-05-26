/**
 * Unit tests for the design-doc validation, AI-fix, and re-validation flow.
 *
 * These scenarios were the biggest pain points during development:
 *   1. Validation agent runs → scorecard detected → status promoted/reset
 *   2. triggerFixValidation sends the right prompt and baseline to the AI
 *   3. acceptFixValidation clears the baseline and re-queues validation
 *   4. cancelValidation stops the watcher and cancels the agent run
 *   5. Stale-result guard prevents an old watcher from overwriting a newer run
 *   6. generateFallbackReport produces valid markdown from a scorecard
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('fs');

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      designDocs: { findFirst: jest.fn() },
      chatThreads: { findFirst: jest.fn() },
    },
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    select: jest.fn(),
  },
}));

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  cancelRun: jest.fn().mockResolvedValue(undefined),
  isThreadIdle: jest.fn().mockReturnValue(false),
  readOutputValidationScorecard: jest.fn().mockReturnValue(null),
  readOutputValidationScorecardMd: jest.fn().mockReturnValue(null),
  readOutputDesignDoc: jest.fn().mockReturnValue(null),
  readOutputTechSpec: jest.fn().mockReturnValue(null),
  readOutputAssumptions: jest.fn().mockReturnValue(null),
  readAllOutputDesignDocFeatures: jest.fn().mockReturnValue([]),
}));

jest.mock('../utils/rbacHelpers', () => ({
  isAdminUser: jest.fn().mockResolvedValue(false),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn().mockResolvedValue(null),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn().mockResolvedValue('default-model'),
}));

jest.mock('../services/prdService', () => ({
  getPrd: jest.fn().mockResolvedValue(null),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import fs from 'fs';
import {
  generateFallbackReport,
  cancelValidation,
  autoStartValidation,
  triggerFixValidation,
  acceptFixValidation,
  startValidationWatcher,
  isValidationWatcherActive,
  syncValidationResult,
} from '../services/designDocService';

// ── Mock handles ──────────────────────────────────────────────────────────────

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const agentSvc = jest.requireMock('../services/chatAgentService') as Record<string, jest.Mock>;
const { getSkillConfig: mockGetSkillConfig } = jest.requireMock(
  '../services/projectSettingsService',
) as { getSkillConfig: jest.Mock };

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeDocRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'doc-1',
    prdId: 'prd-1',
    project: 'proj-alpha',
    chatThreadId: null,
    qaChatThreadId: null,
    docAssistantThreadId: null,
    validationThreadId: null,
    validationScore: null,
    validationScorecard: null,
    validationReportMd: null,
    validationPhase: null,
    fixBaseline: null,
    authorId: 'user-1',
    title: 'Feature A',
    designContent: 'Design content goes here.',
    techSpecContent: 'Tech spec content goes here.',
    assumptionsContent: 'Assumptions content goes here.',
    status: 'draft',
    reviewerId: null,
    reviewComment: null,
    reviewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function makeScorecard(overrides: Partial<Record<string, any>> = {}) {
  return {
    slug: 'feature-a',
    generated_at: '2026-01-01T00:00:00Z',
    review_phase: 'initial' as const,
    overall_score: 85,
    ready_threshold: 90,
    is_ready: false,
    verdict: 'gaps' as const,
    features: [
      {
        feature_slug: 'feature-a',
        feature_title: 'Feature A',
        design_score: 80,
        tech_spec_score: 85,
        assumptions_score: 90,
        overall_score: 85,
        verdict: 'gaps',
        gaps: [
          {
            id: 'gap-1',
            file: 'design.md',
            section: 'Design',
            score: 2,
            description: 'Missing error handling strategy',
            what_3_looks_like: 'Detailed error codes, retry logic, and fallback behavior',
            resolution: 'pending' as const,
          },
          {
            id: 'gap-2',
            file: 'tech-spec.md',
            section: 'Tech Spec',
            score: 1,
            description: 'No migration plan',
            what_3_looks_like: 'Step-by-step migration plan with rollback',
            resolution: 'pending' as const,
          },
        ],
      },
    ],
    cross_cutting_checks: { 'Security Review': 'PASS' },
    accepted_gaps: [],
    deferred_gaps: [],
    ...overrides,
  };
}

/** Fluent select chain that resolves to `rows` from `.limit()` and `.orderBy()`. */
function makeSelectChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.leftJoin = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.orderBy = jest.fn().mockResolvedValue(rows);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

/** Fluent update chain — `set` returns `this`, `where` resolves. */
function makeUpdateChain() {
  const chain: any = {};
  chain.set = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockResolvedValue(undefined);
  return chain;
}

/** Flush enough promise microtasks to drain async chains inside setInterval callbacks. */
async function flushAllPromises(depth = 8): Promise<void> {
  for (let i = 0; i < depth; i++) {
    await Promise.resolve();
  }
}

// ── generateFallbackReport ────────────────────────────────────────────────────

describe('generateFallbackReport', () => {
  it('produces a markdown table with overall score, verdict, phase, and readiness', () => {
    const scorecard = makeScorecard({ overall_score: 88, verdict: 'gaps', is_ready: false });
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('88%');
    expect(report).toContain('gaps');
    expect(report).toContain('initial');
    expect(report).toContain('No');
  });

  it('includes feature score rows when features are present', () => {
    const scorecard = makeScorecard();
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('Feature A');
    expect(report).toContain('80%'); // design_score
    expect(report).toContain('85%'); // tech_spec_score
  });

  it('lists open (pending) gaps in the Open Gaps section', () => {
    const scorecard = makeScorecard();
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('Open Gaps');
    expect(report).toContain('Missing error handling strategy');
    expect(report).toContain('No migration plan');
  });

  it('includes cross-cutting checks when present', () => {
    const scorecard = makeScorecard({ cross_cutting_checks: { 'Accessibility': 'FAIL' } });
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('Cross-Cutting Checks');
    expect(report).toContain('Accessibility');
    expect(report).toContain('FAIL');
  });

  it('lists accepted and deferred gaps when present', () => {
    const scorecard = makeScorecard({
      accepted_gaps: ['Accepted gap A'],
      deferred_gaps: ['Deferred gap B'],
    });
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('Accepted Gaps');
    expect(report).toContain('Accepted gap A');
    expect(report).toContain('Deferred Gaps');
    expect(report).toContain('Deferred gap B');
  });

  it('shows is_ready as Yes when scorecard is ready', () => {
    const scorecard = makeScorecard({ overall_score: 95, is_ready: true, verdict: 'ready' });
    const report = generateFallbackReport(scorecard as any);

    expect(report).toContain('Yes');
  });

  it('omits Open Gaps section when all gaps are resolved (no pending gaps)', () => {
    const scorecard = makeScorecard();
    // Override resolution to non-pending values via cast
    (scorecard.features[0].gaps[0] as any).resolution = 'filled';
    (scorecard.features[0].gaps[1] as any).resolution = 'accepted';
    const report = generateFallbackReport(scorecard as any);

    expect(report).not.toContain('Open Gaps');
  });
});

// ── syncValidationResult ──────────────────────────────────────────────────────

describe('syncValidationResult', () => {
  beforeEach(() => jest.clearAllMocks());

  it('always persists validationReportMd — uses provided markdown when given', async () => {
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await syncValidationResult('doc-1', makeScorecard() as any, '## My Report');

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ validationReportMd: '## My Report' }),
    );
  });

  it('generates fallback markdown report when none is provided', async () => {
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await syncValidationResult('doc-1', makeScorecard() as any);

    const payload = chain.set.mock.calls[0][0];
    expect(typeof payload.validationReportMd).toBe('string');
    expect(payload.validationReportMd).toContain('Validation Report');
  });

  it('sets status to pending_review when scorecard.is_ready is true', async () => {
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await syncValidationResult('doc-1', makeScorecard({ overall_score: 95, is_ready: true }) as any);

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending_review' }),
    );
  });

  it('sets status to draft when scorecard.is_ready is false', async () => {
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await syncValidationResult('doc-1', makeScorecard({ overall_score: 70, is_ready: false }) as any);

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('rounds overall_score when persisting validationScore', async () => {
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await syncValidationResult('doc-1', makeScorecard({ overall_score: 87.6 }) as any);

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ validationScore: 88 }),
    );
  });
});

// ── cancelValidation ──────────────────────────────────────────────────────────

describe('cancelValidation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws 404 when the design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(cancelValidation('doc-missing', 'user-1')).rejects.toMatchObject({
      message: 'Design doc not found',
      status: 404,
    });
  });

  it('throws 403 when a non-author tries to cancel', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'validating' }));

    await expect(cancelValidation('doc-1', 'user-other')).rejects.toMatchObject({
      message: 'Only the author can cancel validation',
      status: 403,
    });
  });

  it('throws 409 when status is not "validating"', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'draft' }));

    await expect(cancelValidation('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot cancel validation from status 'draft'"),
      status: 409,
    });
  });

  it('resets status to draft when cancellation succeeds', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow({ status: 'validating' }));
    const chain = makeUpdateChain();
    mockDb.update.mockReturnValue(chain);

    await cancelValidation('doc-1', 'user-1');

    expect(chain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('calls cancelRun with the stored validationThreadId', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationThreadId: 'thread-v1' }),
    );
    mockDb.update.mockReturnValue(makeUpdateChain());

    await cancelValidation('doc-1', 'user-1');

    expect(agentSvc.cancelRun).toHaveBeenCalledWith('thread-v1');
  });

  it('does not call cancelRun when validationThreadId is null', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(
      makeDocRow({ status: 'validating', validationThreadId: null }),
    );
    mockDb.update.mockReturnValue(makeUpdateChain());

    await cancelValidation('doc-1', 'user-1');

    expect(agentSvc.cancelRun).not.toHaveBeenCalled();
  });
});

// ── autoStartValidation ───────────────────────────────────────────────────────

describe('autoStartValidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns without creating a thread when the design doc does not exist', async () => {
    // getDesignDoc (db.select chain) returns empty → doc is null
    mockDb.select.mockReturnValue(makeSelectChain([]));

    await autoStartValidation('doc-missing');

    expect(agentSvc.createThread).not.toHaveBeenCalled();
  });

  it('returns without creating a thread when no validation skill is configured', async () => {
    const docRow = makeDocRow({ status: 'draft' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({ designDocValidationSkillPath: null });

    await autoStartValidation('doc-1');

    expect(agentSvc.createThread).not.toHaveBeenCalled();
  });

  it('creates a new validation thread and stores its ID in the DB', async () => {
    const docRow = makeDocRow({ status: 'draft', prdId: 'prd-1' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
      skillBranch: 'main',
      designDocValidationModel: null,
    });
    agentSvc.createThread.mockResolvedValue({ id: 'thread-v1', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await autoStartValidation('doc-1');

    expect(agentSvc.createThread).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ validationThreadId: 'thread-v1' }),
    );
  });

  it('sets status to "validating" when the doc is in a status that allows it', async () => {
    const docRow = makeDocRow({ status: 'draft' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
      skillBranch: 'main',
    });
    agentSvc.createThread.mockResolvedValue({ id: 'thread-v1', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await autoStartValidation('doc-1');

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'validating' }),
    );
  });

  it('does not change status when doc is already "approved"', async () => {
    const docRow = makeDocRow({ status: 'approved' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
      skillBranch: 'main',
    });
    agentSvc.createThread.mockResolvedValue({ id: 'thread-v1', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await autoStartValidation('doc-1');

    const payload = updateChain.set.mock.calls[0][0];
    expect(payload).not.toHaveProperty('status');
  });

  it('clears all previous validation fields so the UI shows a fresh run', async () => {
    const docRow = makeDocRow({ status: 'draft', validationScore: 75 });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
      skillBranch: 'main',
    });
    agentSvc.createThread.mockResolvedValue({ id: 'thread-v2', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await autoStartValidation('doc-1');

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        validationScore: null,
        validationScorecard: null,
        validationReportMd: null,
        validationPhase: null,
      }),
    );
  });

  it('includes PRD content in the context passed to the validation agent', async () => {
    const docRow = makeDocRow({ status: 'draft', prdId: 'prd-1' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
    });
    const { getPrd: mockGetPrd } = jest.requireMock('../services/prdService') as { getPrd: jest.Mock };
    mockGetPrd.mockResolvedValue({ id: 'prd-1', content: 'PRD content here' });
    agentSvc.createThread.mockResolvedValue({ id: 'thread-v1', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    await autoStartValidation('doc-1');

    const callArgs = agentSvc.createThread.mock.calls[0][1];
    expect(callArgs.freeformContext).toContain('PRD content here');
  });
});

// ── triggerFixValidation ──────────────────────────────────────────────────────

describe('triggerFixValidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Default: fs mocks are no-ops
    (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
    (fs.appendFileSync as jest.Mock).mockImplementation(() => {});
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  function setupDocWithScorecard(overrides: Partial<Record<string, any>> = {}) {
    const scorecard = makeScorecard();
    const docRow = makeDocRow({
      status: 'draft',
      validationScorecard: scorecard,
      ...overrides,
    });
    // getDesignDoc uses db.select; triggerFixValidation may also call db.select for thread ownership
    mockDb.select.mockImplementation(() => makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]));
    return { docRow, scorecard };
  }

  it('throws 404 when the design doc does not exist', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));

    await expect(triggerFixValidation('doc-missing', 'user-1')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('throws 409 when status is not draft or revision_requested', async () => {
    const docRow = makeDocRow({ status: 'pending_review', validationScorecard: makeScorecard() });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]));

    await expect(triggerFixValidation('doc-1', 'user-1')).rejects.toMatchObject({
      message: expect.stringContaining("Cannot fix validation from status 'pending_review'"),
      status: 409,
    });
  });

  it('throws 409 when no validation scorecard is available', async () => {
    const docRow = makeDocRow({ status: 'draft', validationScorecard: null });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]));

    await expect(triggerFixValidation('doc-1', 'user-1')).rejects.toMatchObject({
      message: 'No validation scorecard available to fix',
      status: 409,
    });
  });

  it('creates a new assistant thread when none is stored', async () => {
    setupDocWithScorecard({ docAssistantThreadId: null });
    agentSvc.createThread.mockResolvedValue({ id: 'fix-thread-1', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    const result = await triggerFixValidation('doc-1', 'user-1');

    expect(agentSvc.createThread).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ threadId: 'fix-thread-1' });
  });

  it('reuses the stored assistant thread when it belongs to the requesting user', async () => {
    setupDocWithScorecard({ docAssistantThreadId: 'existing-thread' });
    // Thread ownership check: db.select for chatThreads returns matching userId
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ designDoc: makeDocRow({ status: 'draft', validationScorecard: makeScorecard(), docAssistantThreadId: 'existing-thread' }), reviewerDisplayName: null }]))
      .mockReturnValueOnce(makeSelectChain([{ userId: 'user-1' }]))       // ownership check
      .mockReturnValueOnce(makeSelectChain([{ workspaceDir: '/tmp/ws' }])); // workspace lookup
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    const result = await triggerFixValidation('doc-1', 'user-1');

    expect(agentSvc.createThread).not.toHaveBeenCalled();
    expect(result).toEqual({ threadId: 'existing-thread' });
  });

  it('creates a new thread when the stored thread belongs to a different user', async () => {
    mockDb.select
      .mockReturnValueOnce(makeSelectChain([{ designDoc: makeDocRow({ status: 'draft', validationScorecard: makeScorecard(), docAssistantThreadId: 'other-thread' }), reviewerDisplayName: null }]))
      .mockReturnValueOnce(makeSelectChain([{ userId: 'user-other' }])); // ownership check → different user
    agentSvc.createThread.mockResolvedValue({ id: 'new-thread-2', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    const result = await triggerFixValidation('doc-1', 'user-1');

    expect(agentSvc.createThread).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ threadId: 'new-thread-2' });
  });

  it('persists a fixBaseline snapshot that includes the thread ID', async () => {
    setupDocWithScorecard({ docAssistantThreadId: null });
    agentSvc.createThread.mockResolvedValue({ id: 'fix-thread-1', workspaceDir: '/tmp/ws' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await triggerFixValidation('doc-1', 'user-1');

    const baselineCalls = updateChain.set.mock.calls.filter(
      (call: any[]) => call[0].fixBaseline !== undefined,
    );
    expect(baselineCalls.length).toBeGreaterThan(0);
    const baseline = baselineCalls[0][0].fixBaseline;
    expect(baseline).toMatchObject({
      design: 'Design content goes here.',
      techSpec: 'Tech spec content goes here.',
      assumptions: 'Assumptions content goes here.',
      fixThreadId: 'fix-thread-1',
    });
  });

  it('fires sendMessage fire-and-forget with a prompt that references all pending gaps', async () => {
    setupDocWithScorecard({ docAssistantThreadId: null });
    agentSvc.createThread.mockResolvedValue({ id: 'fix-thread-1', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    await triggerFixValidation('doc-1', 'user-1');

    expect(agentSvc.sendMessage).toHaveBeenCalledWith(
      'fix-thread-1',
      expect.stringContaining('Missing error handling strategy'),
    );
    expect(agentSvc.sendMessage).toHaveBeenCalledWith(
      'fix-thread-1',
      expect.stringContaining('No migration plan'),
    );
  });

  it('prompt instructs the AI to call update_design_doc for each affected section', async () => {
    setupDocWithScorecard({ docAssistantThreadId: null });
    agentSvc.createThread.mockResolvedValue({ id: 'fix-thread-1', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    await triggerFixValidation('doc-1', 'user-1');

    const prompt = agentSvc.sendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('update_design_doc');
    expect(prompt).toContain('YOU MUST CALL THE TOOL');
  });

  it('works from revision_requested status (not just draft)', async () => {
    const docRow = makeDocRow({ status: 'revision_requested', validationScorecard: makeScorecard() });
    mockDb.select.mockReturnValue(makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]));
    agentSvc.createThread.mockResolvedValue({ id: 'fix-thread-rev', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    const result = await triggerFixValidation('doc-1', 'user-1');

    expect(result).toEqual({ threadId: 'fix-thread-rev' });
  });
});

// ── acceptFixValidation ───────────────────────────────────────────────────────

describe('acceptFixValidation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('throws 404 when the design doc does not exist', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(null);

    await expect(acceptFixValidation('doc-missing')).rejects.toMatchObject({ status: 404 });
  });

  it('clears fixBaseline from the DB', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());
    // autoStartValidation inside acceptFixValidation will call getDesignDoc via db.select
    const docRow = makeDocRow({ status: 'draft' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    // getSkillConfig returns null → autoStartValidation exits early (no thread creation)
    mockGetSkillConfig.mockResolvedValue(null);
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    await acceptFixValidation('doc-1');

    const clearBaselineCall = updateChain.set.mock.calls.find(
      (call: any[]) => call[0].fixBaseline === null,
    );
    expect(clearBaselineCall).toBeTruthy();
  });

  it('triggers a new validation run by calling autoStartValidation', async () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue(makeDocRow());
    const docRow = makeDocRow({ status: 'draft' });
    mockDb.select.mockReturnValue(
      makeSelectChain([{ designDoc: docRow, reviewerDisplayName: null }]),
    );
    mockGetSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: '/skills/validate.md',
      skillRepo: 'my-repo',
      skillBranch: 'main',
    });
    agentSvc.createThread.mockResolvedValue({ id: 're-validate-thread', workspaceDir: '/tmp/ws' });
    mockDb.update.mockReturnValue(makeUpdateChain());

    await acceptFixValidation('doc-1');

    expect(agentSvc.createThread).toHaveBeenCalledTimes(1);
  });
});

// ── startValidationWatcher ────────────────────────────────────────────────────

describe('startValidationWatcher', () => {
  const TICK = 5001; // slightly over VALIDATION_WATCHER_INTERVAL_MS (5000ms)

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Ensure chatThreads.findFirst (used by cleanupWorkspace) returns nothing
    mockDb.query.chatThreads.findFirst.mockResolvedValue(null);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports as active immediately after starting', () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ validationThreadId: 'thread-v1' });
    startValidationWatcher('doc-watcher-1', 'thread-v1');
    expect(isValidationWatcherActive('doc-watcher-1')).toBe(true);
  });

  it('syncs validation result and deactivates when scorecard arrives on first tick', async () => {
    const scorecard = makeScorecard({ overall_score: 92, is_ready: true });
    agentSvc.readOutputValidationScorecard.mockReturnValue(JSON.stringify(scorecard));
    agentSvc.readOutputValidationScorecardMd.mockReturnValue('## Report');
    // stale-result guard: the thread is still the active one
    mockDb.query.designDocs.findFirst.mockResolvedValue({ validationThreadId: 'thread-v1' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    startValidationWatcher('doc-sync-1', 'thread-v1');
    jest.advanceTimersByTime(TICK);
    await flushAllPromises();

    expect(isValidationWatcherActive('doc-sync-1')).toBe(false);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        validationScore: 92,
        status: 'pending_review',
        validationReportMd: '## Report',
      }),
    );
  });

  it('resets status to draft when agent finishes without producing a scorecard', async () => {
    agentSvc.readOutputValidationScorecard.mockReturnValue(null);
    agentSvc.isThreadIdle.mockReturnValue(true); // agent is done but no scorecard
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    startValidationWatcher('doc-idle-1', 'thread-idle');
    jest.advanceTimersByTime(TICK);
    await flushAllPromises();

    expect(isValidationWatcherActive('doc-idle-1')).toBe(false);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('keeps polling and does not update DB while agent is still running', async () => {
    agentSvc.readOutputValidationScorecard.mockReturnValue(null);
    agentSvc.isThreadIdle.mockReturnValue(false); // agent still running
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    startValidationWatcher('doc-running-1', 'thread-running');
    jest.advanceTimersByTime(TICK);
    await flushAllPromises();

    expect(isValidationWatcherActive('doc-running-1')).toBe(true);
    expect(updateChain.set).not.toHaveBeenCalled();
  });

  it('discards stale scorecard when a newer validation thread has replaced the one this watcher tracks', async () => {
    const scorecard = makeScorecard({ overall_score: 90, is_ready: true });
    agentSvc.readOutputValidationScorecard.mockReturnValue(JSON.stringify(scorecard));
    // Stale-result guard: DB says current thread is now 'thread-v2', not 'thread-v1'
    mockDb.query.designDocs.findFirst.mockResolvedValue({ validationThreadId: 'thread-v2' });
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    startValidationWatcher('doc-stale-1', 'thread-v1');
    jest.advanceTimersByTime(TICK);
    await flushAllPromises();

    // The interval was cleared (watcher stopped) but the scorecard was NOT synced
    expect(isValidationWatcherActive('doc-stale-1')).toBe(false);
    // syncValidationResult would call db.update with validationScore — should NOT happen
    const scorecardSyncCalls = updateChain.set.mock.calls.filter(
      (call: any[]) => call[0]?.validationScore !== undefined,
    );
    expect(scorecardSyncCalls).toHaveLength(0);
  });

  it('resets status to draft on timeout after max attempts', async () => {
    agentSvc.readOutputValidationScorecard.mockReturnValue(null);
    agentSvc.isThreadIdle.mockReturnValue(false);
    const updateChain = makeUpdateChain();
    mockDb.update.mockReturnValue(updateChain);

    startValidationWatcher('doc-timeout-1', 'thread-slow');

    // VALIDATION_WATCHER_MAX_ATTEMPTS = 720 ticks × 5000ms = 3,600,000ms + 1 tick
    jest.advanceTimersByTime(720 * 5000 + 5001);
    await flushAllPromises();

    expect(isValidationWatcherActive('doc-timeout-1')).toBe(false);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('replaces an existing active watcher when started twice for the same doc', () => {
    mockDb.query.designDocs.findFirst.mockResolvedValue({ validationThreadId: 'thread-v2' });

    startValidationWatcher('doc-replace-1', 'thread-v1');
    expect(isValidationWatcherActive('doc-replace-1')).toBe(true);

    startValidationWatcher('doc-replace-1', 'thread-v2'); // second start replaces first
    expect(isValidationWatcherActive('doc-replace-1')).toBe(true);
    // Only one interval should be active — if two existed and both fired, we'd see
    // double DB writes. That's verified indirectly by the stale-result test above.
  });
});
