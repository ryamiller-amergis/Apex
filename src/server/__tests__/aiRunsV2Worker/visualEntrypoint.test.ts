import { AI_RUN_V2_VISUAL_SPEC_VERSION } from '../../../shared/types/aiRunV2VisualSpec';
import { resolveWorkerEnvironment } from '../../services/aiRunsV2Worker/entrypointSupport';
import { createWorkerServiceBusClient } from '../../services/aiRunsV2Worker/serviceBusClient';
import { createVisualConcurrencyController } from '../../services/aiRunsV2Worker/visualConcurrency';
import { startVisualWorker } from '../../services/aiRunsV2Worker/visualEntrypoint';
import { createV2Worker } from '../../services/aiRunsV2Worker/worker';

jest.mock('../../services/aiRunsV2Worker/entrypointSupport', () => ({
  resolveWorkerEnvironment: jest.fn(),
}));

jest.mock('../../services/aiRunsV2Worker/serviceBusClient', () => ({
  createWorkerServiceBusClient: jest.fn(),
}));

jest.mock('../../services/aiRunsV2Worker/visualConcurrency', () => ({
  createVisualConcurrencyController: jest.fn(),
  isBedrockThrottle: jest.fn(() => false),
}));

jest.mock('../../services/aiRunsV2Worker/worker', () => ({
  createV2Worker: jest.fn(),
}));

const mockedResolveWorkerEnvironment =
  resolveWorkerEnvironment as jest.MockedFunction<typeof resolveWorkerEnvironment>;
const mockedCreateWorkerServiceBusClient =
  createWorkerServiceBusClient as jest.MockedFunction<
    typeof createWorkerServiceBusClient
  >;
const mockedCreateVisualConcurrencyController =
  createVisualConcurrencyController as jest.MockedFunction<
    typeof createVisualConcurrencyController
  >;
const mockedCreateV2Worker =
  createV2Worker as jest.MockedFunction<typeof createV2Worker>;

const visualSpecification = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype' as const,
  prototypePrompt: { branch: 'maxview' as const },
  promptInputs: {
    featureName: 'Standup summary',
    featureDescription: '',
    planSection: '',
    pbiSection: '### PBI 1: Show the summary',
    scopingSection: 'Only render the described feature.',
    extendMode: false,
    targetRoute: null,
    existingPageContext: '',
    targetScreenHint: '',
    pageScreenshotHint: '',
    sourceFiles: [],
    omittedSourcePaths: [],
  },
  designSystem: {},
  designReference: { navItems: [], images: [] },
  model: {
    modelId: 'anthropic.claude',
    region: 'us-east-1',
    maxTokens: 8000,
    timeoutMs: 600_000,
    retry: {
      maxAttempts: 5,
      initialBackoffMs: 2_000,
      backoffMultiplier: 2,
      jitter: true,
    },
  },
  usage: { feature: 'design-prototype' },
  outputPath: 'prototype.html',
};

describe('visual worker entrypoint', () => {
  const runLoop = jest.fn().mockResolvedValue(undefined);
  const processOnce = jest.fn();

  beforeEach(() => {
    mockedResolveWorkerEnvironment.mockReturnValue({
      namespace: '',
      commandQueue: 'visual-commands',
      checkpointQueue: 'visual-checkpoints',
      resultQueue: 'visual-results',
      artifactContainer: 'ai-run-artifacts',
      containerAppsExecutionId: 'exec-7',
      noop: true,
    });
    mockedCreateWorkerServiceBusClient.mockReturnValue({} as never);
    mockedCreateVisualConcurrencyController.mockReturnValue({
      current: () => 1,
      recordSuccess: () => 1,
      recordThrottle: () => 1,
    });
    mockedCreateV2Worker.mockReturnValue({
      processOnce,
      runLoop,
    });
    jest.spyOn(process, 'on').mockImplementation((() => process) as never);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockedResolveWorkerEnvironment.mockReset();
    mockedCreateWorkerServiceBusClient.mockReset();
    mockedCreateVisualConcurrencyController.mockReset();
    mockedCreateV2Worker.mockReset();
  });

  it('wires the absolute command deadline and model timeout into the worker', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-22T12:00:00.000Z'));

    await startVisualWorker();

    const workerDeps = mockedCreateV2Worker.mock.calls[0]?.[0];
    expect(workerDeps?.resolveCommandDeadlineMs).toEqual(expect.any(Function));
    expect(workerDeps?.resolveDeadlineMs).toEqual(expect.any(Function));
    expect(
      workerDeps?.resolveCommandDeadlineMs?.({
        deadlineAt: '2026-09-22T12:00:05.000Z',
      } as never),
    ).toBe(5_000);
    expect(workerDeps?.resolveDeadlineMs?.(visualSpecification as never)).toBe(
      600_000,
    );

    nowSpy.mockRestore();
  });

  it('clamps already-expired visual commands to one millisecond', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-09-22T12:00:00.000Z'));

    await startVisualWorker();

    const workerDeps = mockedCreateV2Worker.mock.calls[0]?.[0];
    expect(
      workerDeps?.resolveCommandDeadlineMs?.({
        deadlineAt: '2026-09-22T11:59:59.000Z',
      } as never),
    ).toBe(1);

    nowSpy.mockRestore();
  });
});
