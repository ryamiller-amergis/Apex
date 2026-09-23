const DESIGN = {
  id: 'design-1',
  project: 'MaxView',
  authorId: 'author-1',
  title: 'Timecards',
  prompt: 'Build a timecard approval queue',
  targetRoute: '/timecards',
  model: null,
  status: 'generating',
  html: null,
  version: 1,
  history: [],
  generationError: null,
  createdAt: '2026-09-22T12:00:00.000Z',
  updatedAt: '2026-09-22T12:00:00.000Z',
};

const mockSelectLimit = jest.fn();
const mockUpdateReturning = jest.fn();
const mockUpdateSet = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: mockSelectLimit,
    })),
    update: jest.fn(() => ({
      set: mockUpdateSet.mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      returning: mockUpdateReturning,
      then: (
        resolve: (value: unknown) => unknown,
        reject: (reason: unknown) => unknown,
      ) => Promise.resolve(undefined).then(resolve, reject),
    })),
  },
}));

jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: jest.fn(async () => ({
    uiLabBedrockModelId: 'anthropic.claude',
    uiLabBedrockMaxTokens: 16_000,
    uiLabBedrockTimeoutMs: 600_000,
    uiLabBedrockTemperature: 0.2,
  })),
}));

const generateUiLabDesign = jest.fn(async ({ onToken }) => {
  onToken('<html>v1</html>');
  return '<html>v1</html>';
});

jest.mock('../services/uiLabBedrockService', () => ({
  generateUiLabDesign: (input: unknown) => generateUiLabDesign(input),
  editUiLabDesign: jest.fn(),
  extractHtml: (html: string) => html,
  resolveUiLabVisualModel: jest.fn(() => ({
    modelId: 'anthropic.claude',
    maxTokens: 16_000,
    timeoutMs: 600_000,
    temperature: 0.2,
    retry: {
      maxAttempts: 3,
      initialBackoffMs: 2_000,
      backoffMultiplier: 2,
      jitter: true,
    },
  })),
  resolveUiLabPromptInput: jest.fn(async () => ({
    userPrompt: DESIGN.prompt,
    targetRoute: DESIGN.targetRoute,
    designSystemName: 'MaxView',
    skillMarkdown: '# UI Lab',
    componentIndex: '',
    existingPageContext: 'export const Timecards = () => null;',
    catalog: { routes: [{ path: '/timecards', title: 'Timecards' }] },
    screenInventory: [],
    colorTokens: 'primary.main: #323695',
  })),
  resolveUiLabDesignReference: jest.fn(() => ({
    navItems: [{ label: 'Home', route: '/home' }],
    images: [
      {
        kind: 'design-reference',
        base64: 'QUJD',
        mediaType: 'image/png',
      },
    ],
  })),
}));

jest.mock('../services/notificationService', () => ({
  createNotification: jest.fn(),
}));
jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));
jest.mock('../services/groupService', () => ({
  getUserGroupNames: jest.fn(),
}));
jest.mock('../services/uiLabShareRepository', () => ({}));

import { runGeneration } from '../services/uiLabService';
import { visualGenerationRunId } from '../services/aiRunV2/v2AdmissionService';

describe('UI Lab V2 generation routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectLimit.mockResolvedValue([DESIGN]);
    mockUpdateReturning.mockResolvedValue([{ id: DESIGN.id }]);
  });

  it('admits initial generation behind its own flag and never starts V1', async () => {
    const admitV2Run = jest.fn().mockResolvedValue({
      status: 'dispatched',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      outboxId: 'outbox-1',
    });
    const observeV2Run = jest.fn().mockResolvedValue(undefined);
    const isFeatureEnabled = jest.fn().mockResolvedValue(true);

    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled,
      admitV2Run,
      reconcileV2Admission: jest.fn(),
      observeV2Run,
      now: () => new Date('2026-09-22T12:01:00.000Z'),
      resolveHardLimitMs: () => 60 * 60_000,
    });

    expect(isFeatureEnabled).toHaveBeenCalledWith(
      'ui-lab-v2-transport',
      {
        userId: 'author-1',
        project: 'MaxView',
        caller: 'ui-lab',
      },
    );
    expect(admitV2Run).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'ui-lab:design-1',
        projectId: 'MaxView',
        workloadLane: 'visual',
        capacityClass: 'interactive',
        specification: expect.objectContaining({
          subjectId: 'design-1',
          subjectKind: 'ui-lab-screen',
          outputPath: 'design.html',
        }),
        executionSnapshot: expect.objectContaining({
          workflowClass: 'ui-lab',
          subjectKind: 'ui-lab-screen',
          subjectId: 'design-1',
          generationStartedAt: '2026-09-22T12:01:00.000Z',
        }),
      }),
    );
    expect(generateUiLabDesign).not.toHaveBeenCalled();
    expect(observeV2Run).toHaveBeenCalledWith(
      expect.objectContaining({
        designId: 'design-1',
        threadId: 'ui-lab:design-1',
      }),
    );
  });

  it('keeps the existing live in-process stream when the flag is off', async () => {
    const onToken = jest.fn();
    const admitV2Run = jest.fn();

    await runGeneration('design-1', onToken, 'user-1', {
      isFeatureEnabled: jest.fn().mockResolvedValue(false),
      admitV2Run,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(generateUiLabDesign).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('<html>v1</html>');
  });

  it('observes an intended run after an ambiguous admission error', async () => {
    const observeV2Run = jest.fn().mockResolvedValue(undefined);
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');

    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run: jest.fn().mockRejectedValue(new Error('response lost')),
      reconcileV2Admission,
      observeV2Run,
      now: () => new Date('2026-09-22T12:01:00.000Z'),
      resolveHardLimitMs: () => 60 * 60_000,
    });

    expect(reconcileV2Admission).toHaveBeenCalledTimes(1);
    expect(observeV2Run).toHaveBeenCalledTimes(1);
    expect(generateUiLabDesign).not.toHaveBeenCalled();
  });

  it('uses V1 only after ambiguous admission is proven absent', async () => {
    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run: jest.fn().mockRejectedValue(new Error('rolled back')),
      reconcileV2Admission: jest.fn().mockResolvedValue('absent'),
      observeV2Run: jest.fn(),
      now: () => new Date('2026-09-22T12:01:00.000Z'),
      resolveHardLimitMs: () => 60 * 60_000,
    });

    expect(generateUiLabDesign).toHaveBeenCalledTimes(1);
  });

  it('does not start V1 when admission conflicts with an unrelated active run', async () => {
    const run = runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run: jest.fn().mockResolvedValue({
        status: 'active_run_conflict',
        existingRunId: 'other-run',
        existingTransportVersion: 'servicebus-blob-v2',
        existingStatus: 'running',
      }),
      reconcileV2Admission: jest.fn().mockResolvedValue('absent'),
      observeV2Run: jest.fn(),
      now: () => new Date('2026-09-22T12:01:00.000Z'),
      resolveHardLimitMs: () => 60 * 60_000,
    });

    await expect(run).rejects.toThrow('conflicted with run other-run');
    expect(generateUiLabDesign).not.toHaveBeenCalled();
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generation_failed',
        generationError: expect.stringContaining('other-run'),
      }),
    );
  });

  it('completes a reconnect after another listener already applied the result', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        ...DESIGN,
        status: 'ready',
        html: '<html>ready</html>',
      },
    ]);
    const admitV2Run = jest.fn();
    const observeV2Run = jest.fn();

    await runGeneration('design-1', jest.fn(), 'user-1', {
      afterEventId: '3f44f6f1-ec42-4aa6-9df4-0d8ce8438491',
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      admitV2Run,
      observeV2Run,
    });

    expect(admitV2Run).not.toHaveBeenCalled();
    expect(observeV2Run).not.toHaveBeenCalled();
    expect(generateUiLabDesign).not.toHaveBeenCalled();
  });

  it('canonicalizes the persisted generation timestamp before reconnect lookup', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        ...DESIGN,
        status: 'streaming',
        updatedAt: '2026-09-22 12:01:00+00',
      },
    ]);
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');
    const observeV2Run = jest.fn().mockResolvedValue(undefined);

    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled: jest.fn().mockResolvedValue(true),
      reconcileV2Admission,
      observeV2Run,
      admitV2Run: jest.fn(),
    });

    const canonical = '2026-09-22T12:01:00.000Z';
    expect(reconcileV2Admission).toHaveBeenCalledWith({
      runId: visualGenerationRunId(
        'ui-lab-screen',
        'design-1',
        canonical,
      ),
      threadId: 'ui-lab:design-1',
      subjectId: 'design-1',
      generationStartedAt: canonical,
    });
    expect(observeV2Run).toHaveBeenCalledTimes(1);
    expect(generateUiLabDesign).not.toHaveBeenCalled();
  });

  it('reconnects an active V2 generation before a now-disabled flag can start V1', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        ...DESIGN,
        status: 'streaming',
        updatedAt: '2026-09-22T12:01:00.000Z',
      },
    ]);
    const isFeatureEnabled = jest.fn().mockResolvedValue(false);
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');
    const observeV2Run = jest.fn().mockResolvedValue(undefined);

    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled,
      reconcileV2Admission,
      observeV2Run,
    });

    expect(reconcileV2Admission).toHaveBeenCalledTimes(1);
    expect(observeV2Run).toHaveBeenCalledTimes(1);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
    expect(generateUiLabDesign).not.toHaveBeenCalled();
  });

  it('reconnects an active V2 generation before a flag evaluation error can start V1', async () => {
    mockSelectLimit.mockResolvedValueOnce([
      {
        ...DESIGN,
        status: 'streaming',
        updatedAt: '2026-09-22T12:01:00.000Z',
      },
    ]);
    const isFeatureEnabled = jest.fn().mockRejectedValue(
      new Error('flag database unavailable'),
    );
    const reconcileV2Admission = jest.fn().mockResolvedValue('intended');
    const observeV2Run = jest.fn().mockResolvedValue(undefined);

    await runGeneration('design-1', jest.fn(), 'user-1', {
      isFeatureEnabled,
      reconcileV2Admission,
      observeV2Run,
    });

    expect(reconcileV2Admission).toHaveBeenCalledTimes(1);
    expect(observeV2Run).toHaveBeenCalledTimes(1);
    expect(isFeatureEnabled).not.toHaveBeenCalled();
    expect(generateUiLabDesign).not.toHaveBeenCalled();
  });
});
