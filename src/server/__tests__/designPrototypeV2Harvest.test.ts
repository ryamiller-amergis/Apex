/**
 * Harvest tests for the visual V2 lane.
 *
 * The blob reader and the attempt reader are injected; the Drizzle `db` is
 * mocked so the assertions cover the real domain write — the row a harvested
 * prototype ends up with must be the row `generateSinglePrototype` writes.
 */

const mockUpdateReturning = jest.fn();
const mockUpdateWhere = jest.fn((..._args: unknown[]) => ({ returning: mockUpdateReturning }));
const mockUpdateSet = jest.fn((..._args: unknown[]) => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn((..._args: unknown[]) => ({ set: mockUpdateSet }));
const mockSelectLimit = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    update: (...args: unknown[]) => mockUpdate(...args),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: (...args: unknown[]) => mockSelectLimit(...args) }),
        }),
      }),
    }),
  },
}));

jest.mock('../services/aiCompletionNotifier', () => ({
  notifyAiCompletion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/aiUsageService', () => ({
  computeCost: jest.fn().mockResolvedValue(0.25),
  recordAiUsage: jest.fn(),
}));

import { createHash } from 'node:crypto';
import type { AiRunBlobRef } from '../../shared/types/aiRunV2';
import { VISUAL_USAGE_FILE_NAME } from '../../shared/types/aiRunV2VisualSpec';
import { ArtifactVerificationError } from '../services/aiRunV2/artifactReader';
import type { FinishedV2Attempt } from '../services/aiRunV2/finishedAttemptReader';
import { harvestFinishedV2Prototypes } from '../services/designPrototypeV2Harvest';

const { notifyAiCompletion } = jest.requireMock('../services/aiCompletionNotifier');
const { computeCost, recordAiUsage } = jest.requireMock('../services/aiUsageService');

const MANIFEST_REF: AiRunBlobRef = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/manifest.json',
};

const PROTOTYPE_HTML = '<!DOCTYPE html><html><body><h1>Standup summary</h1></body></html>';

function entry(path: string, body: string) {
  return {
    path,
    ref: { container: 'ai-run-artifacts', key: `runs/run-1/attempts/1/${path}` },
    sha256: createHash('sha256').update(body).digest('hex'),
    sizeBytes: Buffer.byteLength(body),
  };
}

const USAGE_JSON = JSON.stringify({
  modelId: 'us.anthropic.claude-sonnet-4-5-v1:0',
  feature: 'design-prototype',
  project: 'Apex',
  userId: 'user-1',
  inputTokens: 1200,
  outputTokens: 8400,
  durationMs: 41_000,
});

function manifest(paths: string[] = ['prototype.html', VISUAL_USAGE_FILE_NAME]) {
  const bodies: Record<string, string> = {
    'prototype.html': PROTOTYPE_HTML,
    [VISUAL_USAGE_FILE_NAME]: USAGE_JSON,
  };
  return {
    schemaVersion: 1,
    transport: 'servicebus-blob-v2',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    writtenAt: '2026-09-21T12:00:00.000Z',
    files: paths.map((path) => entry(path, bodies[path])),
  };
}

function completedAttempt(overrides: Partial<FinishedV2Attempt> = {}): FinishedV2Attempt {
  return {
    attemptId: 'attempt-1',
    runId: 'run-1',
    threadId: 'prototype:prototype-1',
    dispatchMessageId: 'dispatch-1',
    status: 'completed',
    manifestRef: MANIFEST_REF,
    failureDetail: null,
    ...overrides,
  };
}

function arrangeArtifacts(files: string[] = ['prototype.html', VISUAL_USAGE_FILE_NAME]) {
  const bodies: Record<string, string> = {
    'prototype.html': PROTOTYPE_HTML,
    [VISUAL_USAGE_FILE_NAME]: USAGE_JSON,
  };
  return {
    readManifest: jest.fn().mockResolvedValue(manifest(files)),
    readFile: jest.fn(),
    readText: jest.fn(async (_m: unknown, path: string) => {
      if (!files.includes(path)) {
        throw new ArtifactVerificationError(`Artifact manifest has no file at ${path}`);
      }
      return bodies[path];
    }),
  };
}

/** One prototype sitting in `generating`, with one finished attempt behind it. */
function arrangeSweep(attempt: FinishedV2Attempt | null) {
  mockSelectLimit.mockResolvedValue([
    { id: 'prototype-1', featureName: 'Standup summary' },
  ]);
  const finishedAttempts = {
    listFinishedByThread: jest.fn().mockResolvedValue(
      attempt ? new Map([[attempt.threadId, attempt]]) : new Map(),
    ),
    claimHarvest: jest.fn().mockResolvedValue('claimed'),
    completeHarvest: jest.fn().mockResolvedValue(undefined),
  };
  return finishedAttempts;
}

/** The compare-and-set applied the row (`true`) or found it already moved. */
function arrangeApply(won: boolean): void {
  mockUpdateReturning.mockResolvedValue(won ? [{ id: 'prototype-1' }] : []);
}

beforeEach(() => {
  jest.clearAllMocks();
  arrangeApply(true);
});

describe('harvestFinishedV2Prototypes', () => {
  it('writes the row generateSinglePrototype writes on success', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('pending_review');
    expect(written.mockVersion).toBe(1);
    expect(written.generationError).toBeNull();
    expect(written.mockHtml).toContain('<h1>Standup summary</h1>');
    expect(written.history).toEqual([
      { version: 1, html: written.mockHtml, createdAt: written.updatedAt },
    ]);
    expect(notifyAiCompletion).toHaveBeenCalledWith(
      'design_prototype_generated',
      'prototype-1',
      { title: 'Standup summary' },
    );
  });

  it('records the cost the worker reported in usage.json', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(computeCost).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bedrock',
        modelId: 'us.anthropic.claude-sonnet-4-5-v1:0',
        inputTokens: 1200,
        outputTokens: 8400,
      }),
    );
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'bedrock',
        feature: 'design-prototype',
        project: 'Apex',
        entityType: 'design-prototype',
        entityId: 'prototype-1',
        userId: 'user-1',
        runId: 'run-1',
        inputTokens: 1200,
        outputTokens: 8400,
        durationMs: 41_000,
        costUsd: 0.25,
        status: 'success',
      }),
    );
  });

  it('still applies the artifact when the worker reported no usage', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts(['prototype.html']);

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(mockUpdateSet.mock.calls[0][0]).toMatchObject({ status: 'pending_review' });
    expect(recordAiUsage).not.toHaveBeenCalled();
  });

  it('never applies a failed run as a success', async () => {
    const finishedAttempts = arrangeSweep(
      completedAttempt({ status: 'failed', manifestRef: null, failureDetail: 'Bedrock throttled' }),
    );
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(artifacts.readManifest).not.toHaveBeenCalled();
    expect(recordAiUsage).not.toHaveBeenCalled();
    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('generation_failed');
    expect(written.generationError).toContain('Bedrock throttled');
  });

  /**
   * The row must read the same whichever transport ran the prototype:
   * `generateSinglePrototype` catches `BedrockModelTruncatedError` and writes
   * `err.message`, so the harvest has to put the worker's detail through
   * unchanged rather than summarising it as a transport failure.
   */
  it('writes the in-process truncation message when the model was cut off', async () => {
    const truncated =
      'Model response was truncated at 32000 output tokens. '
      + 'Increase BEDROCK_UI_MOCK_MAX_TOKENS or use a more concise prompt.';
    const finishedAttempts = arrangeSweep(
      completedAttempt({
        status: 'failed',
        manifestRef: null,
        failureDetail: truncated,
      }),
    );
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('generation_failed');
    expect(written.generationError).toBe(truncated);
    expect(written.mockHtml).toBeUndefined();
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('fails the prototype visibly when the artifact does not match its manifest', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts();
    artifacts.readText.mockRejectedValue(
      new ArtifactVerificationError('Artifact prototype.html failed checksum verification'),
    );

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('generation_failed');
    expect(written.generationError).toContain('failed checksum verification');
    // Re-reading can never succeed, so the claim is closed rather than retried.
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('leaves the claim open when Blob is briefly unreachable', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts();
    artifacts.readManifest.mockRejectedValue(new Error('ECONNRESET'));

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(mockUpdateSet).not.toHaveBeenCalled();
    expect(finishedAttempts.completeHarvest).not.toHaveBeenCalled();
  });

  it('applies an attempt once even when the sweep sees it twice', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    finishedAttempts.claimHarvest
      .mockResolvedValueOnce('claimed')
      .mockResolvedValue('already_harvested');
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });
    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    expect(recordAiUsage).toHaveBeenCalledTimes(1);
  });

  it('records no usage when another writer already moved the prototype', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt());
    const artifacts = arrangeArtifacts();
    arrangeApply(false);

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(recordAiUsage).not.toHaveBeenCalled();
    expect(notifyAiCompletion).not.toHaveBeenCalled();
  });

  it('fails a run that completed without an artifact manifest', async () => {
    const finishedAttempts = arrangeSweep(completedAttempt({ manifestRef: null }));
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(written.status).toBe('generation_failed');
    expect(artifacts.readManifest).not.toHaveBeenCalled();
  });

  it('ignores a prototype the durable transport never ran', async () => {
    const finishedAttempts = arrangeSweep(null);
    const artifacts = arrangeArtifacts();

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(finishedAttempts.claimHarvest).not.toHaveBeenCalled();
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it('asks only for the threads whose prototypes are still generating', async () => {
    const finishedAttempts = arrangeSweep(null);

    await harvestFinishedV2Prototypes({ finishedAttempts, artifacts: arrangeArtifacts() });

    expect(finishedAttempts.listFinishedByThread).toHaveBeenCalledWith([
      'prototype:prototype-1',
    ]);
  });

  it('keeps harvesting the batch after one prototype throws', async () => {
    mockSelectLimit.mockResolvedValue([
      { id: 'prototype-1', featureName: 'Standup summary' },
      { id: 'prototype-2', featureName: 'Standup history' },
    ]);
    const finishedAttempts = {
      listFinishedByThread: jest.fn().mockResolvedValue(
        new Map([
          ['prototype:prototype-1', completedAttempt()],
          [
            'prototype:prototype-2',
            completedAttempt({
              attemptId: 'attempt-2',
              runId: 'run-2',
              threadId: 'prototype:prototype-2',
            }),
          ],
        ]),
      ),
      claimHarvest: jest.fn().mockResolvedValue('claimed'),
      completeHarvest: jest.fn().mockResolvedValue(undefined),
    };
    const artifacts = arrangeArtifacts();
    artifacts.readManifest
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(manifest());

    const harvested = await harvestFinishedV2Prototypes({ finishedAttempts, artifacts });

    expect(harvested).toBe(1);
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-2');
  });
});
