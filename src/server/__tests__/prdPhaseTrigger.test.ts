jest.mock('../db/drizzle', () => {
  const insertChain = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn(),
  };
  return {
    db: {
      query: {
        interviews: { findFirst: jest.fn() },
        prds: { findFirst: jest.fn() },
      },
      insert: jest.fn(() => insertChain),
    },
  };
});

jest.mock('../services/chatAgentService', () => ({
  createThread: jest.fn(),
  getThreadAsync: jest.fn(),
  hydrateThread: jest.fn().mockResolvedValue(true),
  isThreadIdle: jest.fn().mockReturnValue(false),
  readOutputPrd: jest.fn().mockReturnValue(null),
  readOutputBacklog: jest.fn().mockReturnValue(null),
  sendMessage: jest.fn().mockResolvedValue(undefined),
  cancelRun: jest.fn(),
  prepareBackgroundWorkflowTurn: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(),
  getSkillSettingsName: jest.fn(),
  resolveSkillConfig: jest.fn(),
}));

jest.mock('../services/appSettingsService', () => ({
  getDefaultModel: jest.fn(),
}));

jest.mock('../services/linkedContextMaterializerService', () => ({
  atomicWriteDocument: jest.fn(),
}));

jest.mock('../services/runGroundingService', () => ({
  propagatePipelineGrounding: jest.fn(),
  readActiveTargetProvenance: jest.fn(),
  resolveRunGroundingSurface: jest.fn().mockResolvedValue(null),
  runGroundingService: {
    getGroundings: jest.fn().mockResolvedValue([]),
    persistThenMarkTerminalInactive: jest.fn(),
  },
}));

jest.mock('../services/backgroundWorkflowRouter', () => ({
  routeBackgroundWorkflow: jest.fn().mockResolvedValue(undefined),
}));

import { triggerPrdGenerationFromPhaseApproval } from '../services/prdService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };
const chatAgentMocks = jest.requireMock('../services/chatAgentService') as {
  createThread: jest.Mock;
  getThreadAsync: jest.Mock;
};
const { resolveSkillConfig: mockResolveSkillConfig } =
  jest.requireMock('../services/projectSettingsService') as {
    resolveSkillConfig: jest.Mock;
  };
const { getDefaultModel: mockGetDefaultModel } =
  jest.requireMock('../services/appSettingsService') as {
    getDefaultModel: jest.Mock;
  };
const { atomicWriteDocument: mockAtomicWriteDocument } =
  jest.requireMock('../services/linkedContextMaterializerService') as {
    atomicWriteDocument: jest.Mock;
  };
const { routeBackgroundWorkflow: mockRouteBackgroundWorkflow } =
  jest.requireMock('../services/backgroundWorkflowRouter') as {
    routeBackgroundWorkflow: jest.Mock;
  };

const insertChain = mockDb.insert();

const interview = {
  id: 'interview-1',
  title: 'Technical-only interview',
  project: 'proj-alpha',
  repo: 'org/repo',
  model: null,
  effort: 'medium',
  skillSettingsId: 'settings-1',
  chatThreadId: 'interview-thread',
  phaseFlow: 'technical_only',
  requirementsOwnerId: null,
  technicalOwnerId: 'technical-owner',
  requirementsPhaseStatus: null,
  technicalPhaseStatus: 'approved',
  requirementsSummary: null,
  technicalSummary: 'Use the existing PRD pipeline.',
};

describe('triggerPrdGenerationFromPhaseApproval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.query.prds.findFirst.mockResolvedValue(null);
    mockDb.query.interviews.findFirst.mockResolvedValue(interview);
    insertChain.returning.mockResolvedValue([{ id: 'prd-1' }]);
    chatAgentMocks.getThreadAsync.mockResolvedValue({
      messages: [
        { role: 'agent', text: 'Question' },
        { role: 'user', text: 'Original interview prompt' },
      ],
    });
    chatAgentMocks.createThread.mockResolvedValue({
      id: 'prd-thread',
      workspaceDir: 'C:\\work\\prd-thread',
    });
    mockResolveSkillConfig.mockResolvedValue({
      id: 'settings-1',
      skillRepo: 'skills/repo',
      skillBranch: 'main',
      skillProvider: 'ado',
      prdSkillPath: '.cursor/skills/to-prd/SKILL.md',
      prdModel: 'prd-model',
    });
    mockGetDefaultModel.mockResolvedValue('default-model');
    mockRouteBackgroundWorkflow.mockResolvedValue(undefined);
    jest.spyOn(global, 'setInterval').mockReturnValue(123 as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('VT-01 / AC-0 / TBI-003 DoD-1 starts the existing pipeline with configured summaries', async () => {
    await expect(
      triggerPrdGenerationFromPhaseApproval('interview-1'),
    ).resolves.toBeUndefined();

    expect(chatAgentMocks.createThread).toHaveBeenCalledWith(
      'technical-owner',
      expect.objectContaining({
        project: 'proj-alpha',
        repo: 'skills/repo',
        skillPath: '.cursor/skills/to-prd/SKILL.md',
        model: 'prd-model',
      }),
      { skipAutoKickoff: true },
    );
    expect(mockAtomicWriteDocument).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]prd-thread[\\/]\.ai-pilot[\\/]kickoff-transcript\.md$/),
      expect.stringContaining('## Technical Phase Summary'),
    );
    expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      interviewId: 'interview-1',
      authorId: 'technical-owner',
      chatThreadId: 'prd-thread',
      status: 'generating',
    }));
    expect(mockRouteBackgroundWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      flow: 'requirements_only',
      requirementsOwnerId: 'requirements-owner',
      technicalOwnerId: null,
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: null,
      expectedOwner: 'requirements-owner',
      expectedHeading: '## Requirements Phase Summary',
      omittedHeading: '## Technical Phase Summary',
    },
    {
      flow: 'both_sequential',
      requirementsOwnerId: 'requirements-owner',
      technicalOwnerId: 'technical-owner',
      requirementsPhaseStatus: 'approved',
      technicalPhaseStatus: 'approved',
      expectedOwner: 'technical-owner',
      expectedHeading: '## Technical Phase Summary',
      omittedHeading: null,
    },
  ])(
    'TBI-003 DoD-3 starts the $flow flow with its final phase owner',
    async ({
      flow,
      requirementsOwnerId,
      technicalOwnerId,
      requirementsPhaseStatus,
      technicalPhaseStatus,
      expectedOwner,
      expectedHeading,
      omittedHeading,
    }) => {
      mockDb.query.interviews.findFirst.mockResolvedValue({
        ...interview,
        phaseFlow: flow,
        requirementsOwnerId,
        technicalOwnerId,
        requirementsPhaseStatus,
        technicalPhaseStatus,
        requirementsSummary: 'Requirements summary.',
      });

      await triggerPrdGenerationFromPhaseApproval('interview-1');

      expect(chatAgentMocks.createThread).toHaveBeenCalledWith(
        expectedOwner,
        expect.any(Object),
        { skipAutoKickoff: true },
      );
      const transcript = mockAtomicWriteDocument.mock.calls[0][1] as string;
      expect(transcript).toContain(expectedHeading);
      if (omittedHeading) expect(transcript).not.toContain(omittedHeading);
    },
  );

  it('VT-02 / TBI-003 NFR is idempotent when any PRD already exists', async () => {
    mockDb.query.prds.findFirst.mockResolvedValue({ id: 'existing-prd' });

    await triggerPrdGenerationFromPhaseApproval('interview-1');

    expect(chatAgentMocks.createThread).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('VT-03 / AC-1 swallows and logs a trigger start failure', async () => {
    const error = new Error('thread unavailable');
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    chatAgentMocks.createThread.mockRejectedValue(error);

    await expect(
      triggerPrdGenerationFromPhaseApproval('interview-1'),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      '[prdPhaseTrigger] Failed to start PRD generation (interviewId=interview-1):',
      error,
    );
  });
});
