import type { ContainerClient } from '@azure/storage-blob';
import {
  buildAttemptPrefix,
  createArtifactUploader,
} from '../../services/aiRunsV2Worker/artifactUploader';
import {
  createVisualConcurrencyController,
  isBedrockThrottle,
  VISUAL_MAX_CONCURRENCY,
  VISUAL_MIN_CONCURRENCY,
} from '../../services/aiRunsV2Worker/visualConcurrency';
import { createResultPublisher } from '../../services/aiRunsV2Worker/resultPublisher';

function fakeContainer(uploads: string[]): ContainerClient {
  return {
    getBlockBlobClient: (key: string) => ({
      uploadData: async () => {
        uploads.push(key);
      },
    }),
  } as unknown as ContainerClient;
}

describe('artifactUploader', () => {
  it('writes every file under the attempt prefix and the manifest last', async () => {
    const uploads: string[] = [];
    const uploader = createArtifactUploader({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 2,
        container: 'ai-run-artifacts',
      },
      getContainerClient: () => fakeContainer(uploads),
    });

    const manifestRef = await uploader.uploadAll([
      { path: 'design.md', content: '# design' },
      { path: 'output/spec.json', content: '{}' },
    ]);

    const prefix = buildAttemptPrefix('run-1', 2);
    expect(uploads).toEqual([
      `${prefix}/design.md`,
      `${prefix}/output/spec.json`,
      `${prefix}/manifest.json`,
    ]);
    expect(manifestRef).toEqual({
      container: 'ai-run-artifacts',
      key: `${prefix}/manifest.json`,
    });
  });

  it('keeps attempts on separate immutable prefixes', () => {
    expect(buildAttemptPrefix('run-1', 1)).not.toEqual(
      buildAttemptPrefix('run-1', 2),
    );
  });

  it('passes the attempt AbortSignal to every Blob upload', async () => {
    const seenSignals: Array<AbortSignal | undefined> = [];
    const controller = new AbortController();
    const uploader = createArtifactUploader({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        container: 'ai-run-artifacts',
      },
      getContainerClient: () =>
        ({
          getBlockBlobClient: () => ({
            uploadData: async (
              _body: unknown,
              options?: { abortSignal?: AbortSignal },
            ) => {
              seenSignals.push(options?.abortSignal);
            },
          }),
        }) as unknown as ContainerClient,
    });

    await uploader.uploadAll(
      [{ path: 'output/design.md', content: '# design' }],
      controller.signal,
    );

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals[0]).toBe(controller.signal);
    expect(seenSignals[1]).toBe(controller.signal);
  });
});

describe('resultPublisher', () => {
  it('publishes one terminal result per attempt', async () => {
    const sent: unknown[] = [];
    const publisher = createResultPublisher({
      target: {
        runId: 'run-1',
        attemptId: 'attempt-1',
        attemptNumber: 1,
        dispatchMessageId: 'dispatch-1',
      },
      send: async (_id, body) => {
        sent.push(body);
      },
    });

    await publisher.publishTerminal({
      status: 'completed',
      artifactStatus: 'manifest_written',
    });
    await publisher.publishTerminal({
      status: 'failed',
      artifactStatus: 'failed',
    });

    expect(sent).toHaveLength(1);
    expect(publisher.hasPublished()).toBe(true);
  });
});

describe('visual concurrency', () => {
  it('starts at two', () => {
    expect(createVisualConcurrencyController().current()).toBe(
      VISUAL_MIN_CONCURRENCY,
    );
  });

  it('promotes only after a clean streak and stops at four', () => {
    const controller = createVisualConcurrencyController({
      promotionStreak: 2,
    });
    controller.recordSuccess();
    expect(controller.current()).toBe(2);
    controller.recordSuccess();
    expect(controller.current()).toBe(3);
    controller.recordSuccess();
    controller.recordSuccess();
    expect(controller.current()).toBe(VISUAL_MAX_CONCURRENCY);
    controller.recordSuccess();
    controller.recordSuccess();
    expect(controller.current()).toBe(VISUAL_MAX_CONCURRENCY);
  });

  it('rolls back a level on throttling and never below two', () => {
    const controller = createVisualConcurrencyController({
      initial: 4,
      promotionStreak: 2,
    });
    expect(controller.recordThrottle()).toBe(3);
    expect(controller.recordThrottle()).toBe(2);
    expect(controller.recordThrottle()).toBe(VISUAL_MIN_CONCURRENCY);
  });

  it('recognizes Bedrock throttling from status or message', () => {
    expect(isBedrockThrottle({ statusCode: 429 })).toBe(true);
    expect(isBedrockThrottle(new Error('ThrottlingException'))).toBe(true);
    expect(isBedrockThrottle(new Error('bad request'))).toBe(false);
    expect(isBedrockThrottle(null)).toBe(false);
  });
});
