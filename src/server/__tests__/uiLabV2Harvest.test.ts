const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn(() => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockSelectLimit = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    update: jest.fn(() => ({ set: mockUpdateSet })),
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: mockSelectLimit,
    })),
  },
}));

jest.mock('../services/aiUsageService', () => ({
  computeCost: jest.fn(async () => 0.25),
  recordAiUsage: jest.fn(async () => undefined),
}));

import type { FinishedV2Attempt } from '../services/aiRunV2/finishedAttemptReader';
import { ArtifactVerificationError } from '../services/aiRunV2/artifactReader';
import {
  harvestFinishedV2UiLabDesigns,
  harvestUiLabV2Run,
} from '../services/uiLabV2Harvest';

const GENERATION_STARTED_AT = '2026-09-22T12:00:00.000Z';
const MANIFEST_REF = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/manifest.json',
};
const HTML = '<!DOCTYPE html><html><body>ready</body></html>';
const USAGE = JSON.stringify({
  modelId: 'anthropic.claude',
  feature: 'ui-lab',
  project: 'MaxView',
  userId: 'user-1',
  inputTokens: 120,
  outputTokens: 3400,
  cacheReadTokens: 8,
  cacheWriteTokens: 3,
  durationMs: 9000,
  tokenSource: 'exact',
});

function attempt(
  overrides: Partial<FinishedV2Attempt> = {},
): FinishedV2Attempt {
  return {
    attemptId: 'attempt-1',
    runId: 'run-1',
    threadId: 'ui-lab:design-1',
    dispatchMessageId: 'dispatch-1',
    status: 'completed',
    manifestRef: MANIFEST_REF,
    failureDetail: null,
    generationOwner: {
      subjectId: 'design-1',
      generationStartedAt: GENERATION_STARTED_AT,
    },
    ...overrides,
  };
}

function finishedAttempts(value: FinishedV2Attempt | null) {
  return {
    listFinishedByThread: jest.fn(async () =>
      value ? new Map([[value.threadId, value]]) : new Map(),
    ),
    listFinishedDocuments: jest.fn(async () => []),
    isDocumentHarvestPending: jest.fn(async () => false),
    recordHarvestFailure: jest.fn(async () => 1),
    claimHarvest: jest.fn(async () => 'claimed' as const),
    completeHarvest: jest.fn(async () => undefined),
  };
}

function artifacts() {
  return {
    readManifest: jest.fn(async () => ({
      files: [
        { path: 'design.html' },
        { path: 'usage.json' },
      ],
    })),
    readFile: jest.fn(),
    readText: jest.fn(async (_manifest: unknown, path: string) =>
      path === 'design.html' ? HTML : USAGE,
    ),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectLimit.mockResolvedValue([
    {
      id: 'design-1',
      title: 'Timecards',
      prompt: 'Build a queue',
      generationStartedAt: GENERATION_STARTED_AT,
    },
  ]);
  mockUpdateReturning.mockResolvedValue([{ id: 'design-1' }]);
});

describe('harvestFinishedV2UiLabDesigns', () => {
  it('applies verified HTML and records usage exactly once after the CAS wins', async () => {
    const attempts = finishedAttempts(attempt());
    const artifactReader = artifacts();

    await expect(
      harvestFinishedV2UiLabDesigns({
        finishedAttempts: attempts,
        artifacts: artifactReader as never,
      }),
    ).resolves.toBe(1);

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'ready',
        html: HTML,
        version: 1,
        generationError: null,
        history: [
          expect.objectContaining({
            version: 1,
            html: HTML,
            prompt: 'Build a queue',
          }),
        ],
      }),
    );
    const { recordAiUsage } = jest.requireMock('../services/aiUsageService');
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'ui-lab',
        project: 'MaxView',
        runId: 'run-1',
        inputTokens: 120,
        outputTokens: 3400,
        cacheReadTokens: 8,
        cacheWriteTokens: 3,
      }),
    );
    expect(attempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('fails visibly when the design artifact cannot be verified', async () => {
    const attempts = finishedAttempts(attempt());
    const artifactReader = artifacts();
    artifactReader.readText.mockRejectedValue(
      new ArtifactVerificationError('Artifact design.html failed checksum verification'),
    );

    await harvestFinishedV2UiLabDesigns({
      finishedAttempts: attempts,
      artifacts: artifactReader as never,
    });

    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generation_failed',
        generationError: expect.stringContaining('checksum verification'),
      }),
    );
    expect(attempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('permanently supersedes output from an older generation', async () => {
    const old = attempt({
      generationOwner: {
        subjectId: 'design-1',
        generationStartedAt: '2026-09-22T11:00:00.000Z',
      },
    });
    const attempts = finishedAttempts(old);
    const artifactReader = artifacts();

    await expect(
      harvestFinishedV2UiLabDesigns({
        finishedAttempts: attempts,
        artifacts: artifactReader as never,
      }),
    ).resolves.toBe(0);

    expect(artifactReader.readManifest).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(attempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('loads the interactive design directly instead of scanning the fallback batch', async () => {
    mockSelectLimit.mockResolvedValue([]);
    const attempts = finishedAttempts(attempt());
    const loadDesign = jest.fn().mockResolvedValue({
      id: 'design-1',
      title: 'Timecards',
      prompt: 'Build a queue',
      generationStartedAt: GENERATION_STARTED_AT,
    });

    await expect(
      harvestUiLabV2Run(
        {
          designId: 'design-1',
          runId: 'run-1',
          generationStartedAt: GENERATION_STARTED_AT,
        },
        {
          loadDesign,
          finishedAttempts: attempts,
          artifacts: artifacts() as never,
        },
      ),
    ).resolves.toMatchObject({
      status: 'settled',
      outcome: 'ready',
    });

    expect(loadDesign).toHaveBeenCalledWith('design-1');
  });
});
