import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AI_RUN_V2_SCHEMA_VERSION } from '../../shared/types/aiRunV2';
import { WalkthroughAnchorSmartTaggingError } from '../../shared/types/walkthroughAnchorSmartTagging';
import { ArtifactVerificationError } from '../services/aiRunV2/artifactReader';
import type {
  FinishedV2DocumentAttempt,
} from '../services/aiRunV2/finishedAttemptReader';
import { harvestFinishedV2Documents } from '../services/documentV2Harvest';

const MANIFEST_REF = {
  container: 'ai-run-artifacts',
  key: 'runs/run-1/attempts/1/manifest.json',
};

function attempt(
  overrides: Partial<FinishedV2DocumentAttempt> = {},
): FinishedV2DocumentAttempt {
  return {
    attemptId: 'attempt-1',
    attemptNumber: 1,
    runId: 'run-1',
    threadId: 'thread-1',
    dispatchMessageId: 'dispatch-1',
    status: 'completed',
    manifestRef: MANIFEST_REF,
    failureDetail: null,
    generationOwner: null,
    workflowClass: 'prd',
    ...overrides,
  };
}

function manifest(files: Record<string, string>) {
  return {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    transport: 'servicebus-blob-v2' as const,
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    writtenAt: '2026-09-22T12:00:00.000Z',
    files: Object.entries(files).map(([filePath, body]) => ({
      path: filePath,
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: Buffer.byteLength(body),
      ref: {
        container: 'ai-run-artifacts',
        key: `runs/run-1/attempts/1/${filePath}`,
      },
    })),
  };
}

function arrange(
  currentAttempt: FinishedV2DocumentAttempt,
  files: Record<string, string> = {
    'output/feature.prd.md': '# PRD',
    'output/feature.backlog.json': '{"epics":[]}',
  },
) {
  const finishedAttempts = {
    listFinishedByThread: jest.fn(),
    listFinishedDocuments: jest.fn().mockResolvedValue([currentAttempt]),
    isDocumentHarvestPending: jest.fn().mockResolvedValue(false),
    recordHarvestFailure: jest.fn().mockResolvedValue(1),
    claimHarvest: jest.fn().mockResolvedValue('claimed'),
    completeHarvest: jest.fn().mockResolvedValue(undefined),
  };
  const artifactManifest = manifest(files);
  const artifacts = {
    readManifest: jest.fn().mockResolvedValue(artifactManifest),
    readText: jest.fn(),
    readFile: jest.fn(async (entry: { path: string }) =>
      Buffer.from(files[entry.path] ?? '', 'utf8')),
  };
  return { finishedAttempts, artifacts };
}

describe('V2 document artifact harvest', () => {
  it('materializes verified outputs and applies the owning PRD workflow', async () => {
    const currentAttempt = attempt();
    const { finishedAttempts, artifacts } = arrange(currentAttempt);
    let harvestedWorkspace = '';
    const applyWorkspace = jest.fn(async ({ workspacePath, attempt: applied }) => {
      harvestedWorkspace = workspacePath;
      expect(applied).toBe(currentAttempt);
      await expect(
        fs.readFile(
          path.join(
            workspacePath,
            '.ai-pilot',
            'output',
            'feature.prd.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('# PRD');
      await expect(
        fs.readFile(
          path.join(
            workspacePath,
            '.ai-pilot',
            'output',
            'feature.backlog.json',
          ),
          'utf8',
        ),
      ).resolves.toBe('{"epics":[]}');
    });

    await expect(
      harvestFinishedV2Documents({
        finishedAttempts,
        artifacts,
        applyWorkspace,
        applySmartTagging: jest.fn(),
      }),
    ).resolves.toBe(1);

    expect(applyWorkspace).toHaveBeenCalledTimes(1);
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
    await expect(fs.stat(harvestedWorkspace)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('materializes documented nested design-spec artifacts', async () => {
    const currentAttempt = attempt({ workflowClass: 'design-doc' });
    const files = {
      'output/billing-design-spec/invoice-design.md': 'design',
      'output/billing-design-spec/invoice-tech-spec.md': 'tech',
      'output/billing-design-spec/invoice-assumptions.md': 'assumptions',
    };
    const { finishedAttempts, artifacts } = arrange(currentAttempt, files);
    const applyWorkspace = jest.fn(async ({ workspacePath }) => {
      await expect(
        fs.readFile(
          path.join(
            workspacePath,
            '.ai-pilot',
            'output',
            'billing-design-spec',
            'invoice-design.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('design');
    });

    await expect(
      harvestFinishedV2Documents({
        finishedAttempts,
        artifacts,
        applyWorkspace,
        applySmartTagging: jest.fn(),
      }),
    ).resolves.toBe(1);
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it.each([
    'prd',
    'design-doc',
    'validation',
    'test-cases',
  ] as const)('routes a failed %s attempt through the workspace completion contract', async (workflowClass) => {
    const currentAttempt = attempt({
      workflowClass,
      status: 'failed',
      manifestRef: null,
      failureDetail: 'Cursor provider failed',
    });
    const { finishedAttempts, artifacts } = arrange(currentAttempt, {});
    const applyWorkspace = jest.fn().mockResolvedValue(undefined);

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace,
      applySmartTagging: jest.fn(),
    });

    expect(artifacts.readManifest).not.toHaveBeenCalled();
    expect(applyWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: currentAttempt,
        failureDetail: 'Cursor provider failed',
      }),
    );
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('applies smart-tagging JSON through its durable domain handler', async () => {
    const currentAttempt = attempt({
      workflowClass: 'walkthrough-smart-tagging',
    });
    const output = JSON.stringify({
      suggestions: [{ testId: 'anchor-1' }],
    });
    const { finishedAttempts, artifacts } = arrange(currentAttempt, {
      'output/walkthrough-anchor-smart-tagging.json': output,
    });
    const applySmartTagging = jest.fn().mockResolvedValue(true);
    const applyWorkspace = jest.fn();

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace,
      applySmartTagging,
    });

    expect(applySmartTagging).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId: 'run-1',
      rawJson: output,
    });
    expect(applyWorkspace).not.toHaveBeenCalled();
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('does not mark smart-tagging harvested when no domain rows were applied', async () => {
    const currentAttempt = attempt({
      workflowClass: 'walkthrough-smart-tagging',
    });
    const output = JSON.stringify({
      suggestions: [{ testId: 'anchor-1' }],
    });
    const { finishedAttempts, artifacts } = arrange(currentAttempt, {
      'output/walkthrough-anchor-smart-tagging.json': output,
    });
    const failWorkflow = jest.fn().mockResolvedValue(undefined);

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace: jest.fn(),
      applySmartTagging: jest.fn().mockResolvedValue(false),
      failWorkflow,
    } as Parameters<typeof harvestFinishedV2Documents>[0] & {
      failWorkflow: typeof failWorkflow;
    });

    expect(failWorkflow).toHaveBeenCalledWith(
      currentAttempt,
      expect.stringMatching(/smart-tagging/i),
    );
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('does not apply an attempt whose durable claim is already complete', async () => {
    const currentAttempt = attempt();
    const { finishedAttempts, artifacts } = arrange(currentAttempt);
    finishedAttempts.claimHarvest.mockResolvedValue('already_harvested');
    const applyWorkspace = jest.fn();

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace,
      applySmartTagging: jest.fn(),
    });

    expect(artifacts.readManifest).not.toHaveBeenCalled();
    expect(applyWorkspace).not.toHaveBeenCalled();
    expect(finishedAttempts.completeHarvest).not.toHaveBeenCalled();
  });

  it('turns permanent verification errors into a visible domain failure', async () => {
    const currentAttempt = attempt();
    const { finishedAttempts, artifacts } = arrange(currentAttempt);
    artifacts.readFile.mockRejectedValue(
      new ArtifactVerificationError('Artifact failed checksum verification'),
    );
    const applyWorkspace = jest.fn().mockResolvedValue(undefined);

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace,
      applySmartTagging: jest.fn(),
    });

    expect(applyWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        failureDetail: expect.stringContaining('checksum verification'),
      }),
    );
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });

  it('leaves the claim open when Blob is temporarily unavailable', async () => {
    const currentAttempt = attempt();
    const { finishedAttempts, artifacts } = arrange(currentAttempt);
    artifacts.readManifest.mockRejectedValue(new Error('ECONNRESET'));

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace: jest.fn(),
      applySmartTagging: jest.fn(),
    });

    expect(finishedAttempts.completeHarvest).not.toHaveBeenCalled();
  });

  it('dead-letters an unclassified apply error after three durable failures', async () => {
    const currentAttempt = attempt();
    const { finishedAttempts, artifacts } = arrange(currentAttempt);
    finishedAttempts.recordHarvestFailure
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const applyWorkspace = jest
      .fn()
      .mockRejectedValue(new Error('unexpected domain write failure'));
    const failWorkflow = jest.fn().mockResolvedValue(undefined);
    const consoleSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    try {
      await expect(
        harvestFinishedV2Documents({
          finishedAttempts,
          artifacts,
          applyWorkspace,
          applySmartTagging: jest.fn(),
          failWorkflow,
        } as Parameters<typeof harvestFinishedV2Documents>[0] & {
          failWorkflow: typeof failWorkflow;
        }),
      ).resolves.toBe(0);
      expect(finishedAttempts.completeHarvest).not.toHaveBeenCalled();

      await expect(
        harvestFinishedV2Documents({
          finishedAttempts,
          artifacts,
          applyWorkspace,
          applySmartTagging: jest.fn(),
          failWorkflow,
        } as Parameters<typeof harvestFinishedV2Documents>[0] & {
          failWorkflow: typeof failWorkflow;
        }),
      ).resolves.toBe(1);
      expect(failWorkflow).toHaveBeenCalledWith(
        currentAttempt,
        expect.stringContaining('unexpected domain write failure'),
      );
      expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith(
        'attempt-1',
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('settles invalid smart-tagging output instead of retrying it forever', async () => {
    const currentAttempt = attempt({
      workflowClass: 'walkthrough-smart-tagging',
    });
    const { finishedAttempts, artifacts } = arrange(currentAttempt, {
      'output/walkthrough-anchor-smart-tagging.json': '{"suggestions":"bad"}',
    });
    const applySmartTagging = jest.fn().mockRejectedValue(
      new WalkthroughAnchorSmartTaggingError(
        'Smart-tagging suggestions must be an array.',
        'INVALID_OUTPUT',
      ),
    );
    const failWorkflow = jest.fn().mockResolvedValue(undefined);

    await harvestFinishedV2Documents({
      finishedAttempts,
      artifacts,
      applyWorkspace: jest.fn(),
      applySmartTagging,
      failWorkflow,
    } as Parameters<typeof harvestFinishedV2Documents>[0] & {
      failWorkflow: typeof failWorkflow;
    });

    expect(failWorkflow).toHaveBeenCalled();
    expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  });
});
