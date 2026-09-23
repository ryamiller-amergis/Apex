import type { ContainerClient } from '@azure/storage-blob';
import {
  buildSpecificationKey,
  createSpecificationWriter,
} from '../services/aiRunV2/specificationWriter';
import {
  agentRunLaneFor,
  createV2AdmissionService,
  visualGenerationRunId,
  visualRunThreadId,
  visualRunThreadPrefix,
} from '../services/aiRunV2/v2AdmissionService';
import type { RunAttemptRepository } from '../services/aiRunV2/runAttemptRepository';

function fakeContainer(
  uploadData: jest.Mock,
): (containerName: string) => ContainerClient {
  return () =>
    ({
      getBlockBlobClient: () => ({ uploadData }),
    }) as unknown as ContainerClient;
}

describe('specificationWriter', () => {
  it('writes one immutable specification per attempt', async () => {
    const uploadData = jest.fn().mockResolvedValue(undefined);
    const writer = createSpecificationWriter({
      getContainerClient: fakeContainer(uploadData),
      containerName: 'ai-run-artifacts',
    });

    const ref = await writer.write({
      runId: 'run-1',
      attemptNumber: 1,
      specification: { prompt: 'build a thing' },
    });

    expect(ref).toEqual({
      container: 'ai-run-artifacts',
      key: buildSpecificationKey('run-1', 1),
    });
    expect(uploadData).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ conditions: { ifNoneMatch: '*' } }),
    );
  });

  it('reuses the existing specification when the attempt is re-dispatched', async () => {
    const uploadData = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('exists'), { statusCode: 409 }));
    const writer = createSpecificationWriter({
      getContainerClient: fakeContainer(uploadData),
      containerName: 'ai-run-artifacts',
    });

    await expect(
      writer.write({
        runId: 'run-1',
        attemptNumber: 1,
        specification: { prompt: 'build a thing' },
      }),
    ).resolves.toEqual({
      container: 'ai-run-artifacts',
      key: buildSpecificationKey('run-1', 1),
    });
  });

  it('surfaces upload failures that are not a pre-existing blob', async () => {
    const uploadData = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('denied'), { statusCode: 403 }));
    const writer = createSpecificationWriter({
      getContainerClient: fakeContainer(uploadData),
      containerName: 'ai-run-artifacts',
    });

    await expect(
      writer.write({ runId: 'run-1', attemptNumber: 1, specification: {} }),
    ).rejects.toThrow('denied');
  });
});

describe('V2 admission', () => {
  const specifications = {
    write: jest.fn().mockResolvedValue({
      container: 'ai-run-artifacts',
      key: 'runs/run-1/attempts/1/spec.json',
    }),
  };

  beforeEach(() => {
    specifications.write.mockClear();
  });

  it('writes the specification before atomically creating the dispatched run', async () => {
    const order: string[] = [];
    specifications.write.mockImplementation(async () => {
      order.push('spec');
      return { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/1/spec.json' };
    });
    const attempts = {
      createDispatchedV2Run: jest.fn(async () => {
        order.push('create-and-dispatch');
        return {
          status: 'dispatched' as const,
          runId: 'run-1',
          attemptId: 'attempt-1',
          attemptNumber: 1,
          dispatchMessageId: 'dispatch-1',
          outboxId: 'outbox-1',
        };
      }),
    } as unknown as RunAttemptRepository;

    const service = createV2AdmissionService({
      attempts,
      specifications,
      newRunId: () => 'run-1',
    });

    await expect(
      service.admit({
        threadId: 'thread-1',
        projectId: 'project-1',
        workloadLane: 'document',
        timeoutAt: '2026-09-18T13:00:00.000Z',
        specification: { prompt: 'write a design doc' },
      }),
    ).resolves.toEqual({
      status: 'dispatched',
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      outboxId: 'outbox-1',
    });
    expect(order).toEqual(['spec', 'create-and-dispatch']);
  });

  it('passes the workload lane into the atomic dispatch transaction', async () => {
    const createDispatchedV2Run = jest.fn(async () => ({
      status: 'dispatched' as const,
      runId: 'run-1',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      dispatchMessageId: 'dispatch-1',
      outboxId: 'outbox-1',
    }));
    const attempts = {
      createDispatchedV2Run,
    } as unknown as RunAttemptRepository;

    const service = createV2AdmissionService({
      attempts,
      specifications,
      newRunId: () => 'run-1',
    });
    await service.admit({
      threadId: 'thread-1',
      projectId: 'project-1',
      workloadLane: 'visual',
      visualSubjectKind: 'design-prototype',
      timeoutAt: '2026-09-18T13:00:00.000Z',
      specification: {},
    });

    expect(createDispatchedV2Run).toHaveBeenCalledWith(
      expect.objectContaining({
        workloadLane: 'visual',
        visualSubjectKind: 'design-prototype',
      }),
    );
  });

  it('returns the atomic create conflict without a second dispatch step', async () => {
    const createDispatchedV2Run = jest.fn(async () => ({
      status: 'active_run_conflict' as const,
      existingRunId: 'run-0',
      existingTransportVersion: 'http-files-v1',
      existingStatus: 'running',
    }));
    const attempts = {
      createDispatchedV2Run,
    } as unknown as RunAttemptRepository;

    const service = createV2AdmissionService({ attempts, specifications });
    const result = await service.admit({
      threadId: 'thread-1',
      projectId: 'project-1',
      workloadLane: 'document',
      timeoutAt: '2026-09-18T13:00:00.000Z',
      specification: {},
    });

    expect(result.status).toBe('active_run_conflict');
    expect(createDispatchedV2Run).toHaveBeenCalledTimes(1);
  });

  it('gives each visual subject a distinct run identity', () => {
    // One active V2 run is allowed per thread, and a PRD generates many
    // prototypes at once, so they cannot share a thread id.
    expect(visualRunThreadId('design-prototype', 'prototype-1')).toBe(
      'prototype:prototype-1',
    );
    expect(visualRunThreadId('design-prototype', 'prototype-1')).not.toBe(
      visualRunThreadId('design-prototype', 'prototype-2'),
    );
    expect(visualRunThreadPrefix('design-prototype')).toBe('prototype:');
  });

  it('keeps the two visual subject kinds in separate thread namespaces', () => {
    // The harvest reads its own threads back by id. Sharing a prefix would
    // let one owner's sweep see a run it knows nothing about.
    expect(visualRunThreadId('ui-lab-screen', 'subject-1')).toBe(
      'ui-lab:subject-1',
    );
    expect(visualRunThreadId('ui-lab-screen', 'subject-1')).not.toBe(
      visualRunThreadId('design-prototype', 'subject-1'),
    );
  });

  it('gives one visual generation a deterministic run id', () => {
    const first = visualGenerationRunId(
      'design-prototype',
      'prototype-1',
      '2026-09-22T12:00:00.000Z',
    );
    const replay = visualGenerationRunId(
      'design-prototype',
      'prototype-1',
      '2026-09-22T12:00:00.000Z',
    );
    const retry = visualGenerationRunId(
      'design-prototype',
      'prototype-1',
      '2026-09-22T12:05:00.000Z',
    );

    expect(replay).toBe(first);
    expect(retry).not.toBe(first);
    expect(first).toMatch(/^visual-[a-f0-9]{32}$/);
  });

  it('maps workload lanes onto the right agent run lane', () => {
    expect(agentRunLaneFor('document')).toBe('background');
    expect(agentRunLaneFor('visual')).toBe('background');
    expect(agentRunLaneFor('fast')).toBe('ai-runs-interactive');
    expect(agentRunLaneFor('agentic')).toBe('ai-runs-interactive');
  });
});
