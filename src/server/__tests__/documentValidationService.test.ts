jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      chatThreads: { findFirst: jest.fn() },
    },
  },
}));

jest.mock('../services/chatAgentService', () => ({
  readOutputValidationScorecard: jest.fn(),
  readOutputValidationScorecardMd: jest.fn(),
  isThreadIdle: jest.fn(),
  createThread: jest.fn().mockResolvedValue({ id: 'thread-validation', workspaceDir: '/tmp/validation' }),
  cancelRun: jest.fn(),
  sendMessage: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn().mockResolvedValue({
    prompt: 'complete frozen document validation prompt',
    model: 'validation-model',
    skillPath: '/skills/validate.md',
    projectId: 'proj-alpha',
    threadWorkspacePath: '/tmp/validation',
  }),
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockImplementation(async (input: { runInProcess(): void }) => {
    await input.runInProcess();
    return { route: 'in-process', reason: 'flag-disabled' };
  }),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn().mockResolvedValue({ state: 'propagated' }),
  runGroundingService: {
    getGroundings: jest.fn().mockImplementation(async (run: {
      runType: string;
      runId: string;
      project: string;
    }) => [{
      ...run,
      id: 'grounding-validation',
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

jest.mock('../services/projectSettingsService', () => {
  const getSkillConfig = jest.fn();
  return {
    getSkillConfig,
    resolveSkillConfig: jest.fn().mockImplementation((opts: { project: string }) => getSkillConfig(opts.project)),
    getSkillSettingsName: jest.fn().mockResolvedValue(null),
  };
});

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

import {
  autoStartDocumentValidation,
  generateFallbackReport,
  stopDocumentValidationWatcher,
} from '../services/documentValidationService';
import type { ValidationScorecard } from '../../shared/types/interview';

const agentSvc = jest.requireMock('../services/chatAgentService') as Record<string, jest.Mock>;
const { routeBackgroundWorkflow: mockRouteBackgroundWorkflow } = jest.requireMock(
  '../services/backgroundWorkflowRouter',
) as { routeBackgroundWorkflow: jest.Mock };
const { getSkillConfig: mockGetSkillConfig } = jest.requireMock(
  '../services/projectSettingsService',
) as { getSkillConfig: jest.Mock };
const { getDefaultModel: mockGetDefaultModel } = jest.requireMock(
  '../services/appSettingsService',
) as { getDefaultModel: jest.Mock };
const { propagatePipelineGrounding: mockPropagatePipelineGrounding } = jest.requireMock(
  '../services/runGroundingService',
) as { propagatePipelineGrounding: jest.Mock };
const { runGroundingService: mockRunGroundingService } = jest.requireMock(
  '../services/runGroundingService',
) as {
  runGroundingService: {
    getGroundings: jest.Mock;
    persistThenMarkTerminalInactive: jest.Mock;
  };
};

function makeScorecard(overrides: Partial<ValidationScorecard> = {}): ValidationScorecard {
  return {
    slug: 'feature-prd',
    generated_at: '2026-01-01T00:00:00Z',
    review_phase: 'final',
    overall_score: 91,
    ready_threshold: 90,
    is_ready: true,
    verdict: 'ready',
    features: [],
    files: [],
    cross_cutting_checks: {},
    accepted_gaps: [],
    deferred_gaps: [],
    ...overrides,
  };
}

describe('generateFallbackReport', () => {
  it('renders scorecard metadata, passing reasons, feature scores, and gap sections', () => {
    const report = generateFallbackReport(
      makeScorecard({
        passing_reasons: ['All required evidence is present.'],
        features: [
          {
            feature_slug: 'slider',
            feature_title: 'Slider Defaults',
            design_score: 90,
            tech_spec_score: 92,
            assumptions_score: 91,
            overall_score: 91,
            verdict: 'ready',
            gaps: [
              {
                id: 'gap-1',
                file: 'design',
                section: 'Assumptions',
                score: 2,
                description: 'Clarify launch assumptions.',
                what_3_looks_like: 'Launch assumptions are explicit.',
                resolution: 'pending',
              },
            ],
          },
        ],
        cross_cutting_checks: {
          traceability: 'No traceability blockers remain.',
        },
        accepted_gaps: ['Manual QA will cover legacy browser behavior.'],
        deferred_gaps: ['Analytics refinement deferred to phase 2.'],
      } as any),
    );

    expect(report).toContain('# Validation Report');
    expect(report).toContain('| Overall Score | **91%** |');
    expect(report).toContain('## Passing Validation Reasons');
    expect(report).toContain('- All required evidence is present.');
    expect(report).toContain('| Slider Defaults | 90% | 92% | 91% | 91% | ready |');
    expect(report).toContain('- **Assumptions** (design): Clarify launch assumptions.');
    expect(report).toContain('- **Traceability**: No traceability blockers remain.');
    expect(report).toContain('- Manual QA will cover legacy browser behavior.');
    expect(report).toContain('- Analytics refinement deferred to phase 2.');
  });

  it('handles PRD validation scorecards that provide files instead of features', () => {
    const report = generateFallbackReport(
      makeScorecard({
        features: undefined,
        files: [
          {
            file: 'prd',
            score: 93,
            verdict: 'ready',
            gaps: [],
          },
        ],
      }),
    );

    expect(report).toContain('# Validation Report');
    expect(report).toContain('**PRD Content** passed at 93%');
    expect(report).not.toContain('## Feature Scores');
  });

  it('lists top-level structural gaps so a 0% fail-fast card explains why', () => {
    const report = generateFallbackReport(
      makeScorecard({
        slug: 'prd-structural',
        overall_score: 0,
        is_ready: false,
        verdict: 'significant_gaps',
        features: undefined,
        files: undefined,
        gaps: [
          {
            id: 'missing-problem-statement',
            file: 'prd.md',
            section: 'Problem Statement',
            score: 0,
            description: 'Required section "Problem Statement" is missing.',
            what_3_looks_like: 'A "## Problem Statement" section with substantive content.',
            resolution: 'pending',
          },
        ],
      }),
    );

    expect(report).toContain('## Open Gaps');
    expect(report).toContain('Required section "Problem Statement" is missing.');
  });
});

describe('autoStartDocumentValidation background routing', () => {
  const makeAdapter = () => ({
    getDocumentId: () => 'prd-1',
    getProject: () => 'proj-alpha',
    getAuthorId: () => 'user-1',
    getSkillSettingsId: () => 'prd-skill-settings',
    getSourceThreadId: () => 'thread-prd',
    getValidationThreadId: () => null,
    getStatus: () => 'draft',
    buildValidationContext: () => '# PRD validation context',
    getSkillPath: () => '/skills/validate.md',
    getModel: () => 'validation-model',
    updateDbForValidationStart: jest.fn().mockResolvedValue(undefined),
    updateDbForValidationResult: jest.fn().mockResolvedValue(undefined),
    updateDbForValidationTimeout: jest.fn().mockResolvedValue(undefined),
    updateDbForValidationError: jest.fn().mockResolvedValue(undefined),
    isCurrentValidationThread: jest.fn().mockResolvedValue(true),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSkillConfig.mockResolvedValue({
      skillRepo: 'org/skills',
      skillBranch: 'main',
    });
    mockGetDefaultModel.mockResolvedValue('default-model');
    mockRouteBackgroundWorkflow.mockImplementation(
      async (input: { runInProcess(): void }) => {
        await input.runInProcess();
        return { route: 'in-process', reason: 'flag-disabled' };
      },
    );
  });

  afterEach(() => stopDocumentValidationWatcher('prd-1'));

  it('AC-3 / DoD-1 routes disabled validation without worker preparation or propagation', async () => {
    const adapter = makeAdapter();

    await autoStartDocumentValidation(adapter);

    expect(mockRouteBackgroundWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowClass: 'validation',
        userId: 'user-1',
        threadId: 'thread-validation',
        prepareWorker: expect.any(Function),
      }),
    );
    expect(agentSvc.prepareBackgroundWorkflowTurn).not.toHaveBeenCalled();
    expect(mockRunGroundingService.getGroundings).not.toHaveBeenCalled();
    expect(mockPropagatePipelineGrounding).not.toHaveBeenCalled();
    expect(agentSvc.sendMessage).toHaveBeenCalledWith(
      'thread-validation',
      expect.stringContaining('review-scorecard.json'),
      undefined,
      [],
      { hidden: true },
    );
  });

  it('inherits parent skillSettingsId onto the validation thread', async () => {
    mockGetSkillConfig.mockResolvedValue({
      id: 'config-from-resolve',
      skillRepo: 'org/skills',
      skillBranch: 'main',
    });
    const adapter = makeAdapter();

    await autoStartDocumentValidation(adapter);

    expect(agentSvc.createThread).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        skillSettingsId: 'prd-skill-settings',
      }),
      { skipAutoKickoff: true },
    );
  });

  it('AC-0: worker validation decision does not call sendMessage', async () => {
    mockRouteBackgroundWorkflow.mockImplementationOnce(async (input) => {
      const prepared = await input.prepareWorker();
      expect(prepared).toEqual(expect.objectContaining({
        prompt: 'complete frozen document validation prompt',
        targetGrounding: expect.objectContaining({
          runId: 'thread-validation',
          repoRole: 'target',
          isActive: true,
        }),
      }));
      return {
        route: 'worker',
        workspacePath: '/pinned',
        runId: 'thread-validation',
      };
    });

    await autoStartDocumentValidation(makeAdapter());

    expect(agentSvc.sendMessage).not.toHaveBeenCalled();
    expect(mockPropagatePipelineGrounding).toHaveBeenCalledWith(
      { runType: 'chat', runId: 'thread-prd', project: 'proj-alpha' },
      { runType: 'chat', runId: 'thread-validation', project: 'proj-alpha' },
      'user-1',
      { deferMaterialization: true },
    );
  });

  it('cold external project: validation preparation failure runs in-process and stays validating', async () => {
    const adapter = makeAdapter();
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

    await autoStartDocumentValidation(adapter);

    expect(adapter.updateDbForValidationError).not.toHaveBeenCalled();
    expect(mockRunGroundingService.persistThenMarkTerminalInactive)
      .not.toHaveBeenCalled();
    expect(agentSvc.sendMessage).toHaveBeenCalledTimes(1);
  });
});
