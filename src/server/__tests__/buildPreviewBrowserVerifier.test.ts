import type { ArtifactRef } from '../../shared/types/build';
import {
  createBuildPreviewBrowserVerifier,
  type BrowserCheckCompletion,
  type BrowserCheckRepository,
  type BrowserEvidenceStore,
  type BrowserJourneyResult,
  type BrowserJourneyRunner,
} from '../services/build/buildPreviewBrowserVerifier';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

function passingJourney(
  overrides: Partial<BrowserJourneyResult> = {}
): BrowserJourneyResult {
  return {
    passed: true,
    screenshot: Buffer.from('png'),
    steps: [
      { name: 'seeded-read', status: 'passed', durationMs: 10 },
      { name: 'persisted-reload', status: 'passed', durationMs: 20 },
    ],
    consoleErrors: [],
    pageErrors: [],
    networkFailures: [],
    a11yViolations: [],
    ...overrides,
  };
}

class MemoryRepository implements BrowserCheckRepository {
  created: Parameters<BrowserCheckRepository['createPending']>[0][] = [];
  completed: BrowserCheckCompletion[] = [];

  async createPending(
    input: Parameters<BrowserCheckRepository['createPending']>[0]
  ): Promise<{ id: string }> {
    this.created.push(input);
    return { id: 'check-1' };
  }

  async complete(input: BrowserCheckCompletion): Promise<void> {
    this.completed.push(input);
  }
}

class MemoryEvidenceStore implements BrowserEvidenceStore {
  constructor(
    private readonly failingName?: 'screenshot.png' | 'browser-check.json'
  ) {}

  writes: Array<{
    checkId: string;
    name: string;
    bytes: Buffer;
    contentType: string;
  }> = [];

  async put(input: {
    checkId: string;
    name: string;
    bytes: Buffer;
    contentType: string;
  }): Promise<ArtifactRef> {
    if (input.name === this.failingName) {
      throw new Error('simulated evidence write failure');
    }
    this.writes.push(input);
    return {
      container: 'build-preview-browser-evidence',
      key: `${input.checkId}/${input.name}`,
    };
  }
}

function request() {
  return {
    revisionId: 'revision-1',
    instanceId: 'instance-1',
    commit: COMMIT,
    artifactDigest: DIGEST,
    targetUrl: 'http://127.0.0.1:49123',
    journeyVersion: 'full-stack-express:profile:v1',
  };
}

function createVerifier(
  result: BrowserJourneyResult | Error,
  failingEvidenceName?: 'screenshot.png' | 'browser-check.json'
) {
  const repository = new MemoryRepository();
  const evidence = new MemoryEvidenceStore(failingEvidenceName);
  const runner: BrowserJourneyRunner = {
    run: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    evidence,
    repository,
    verifier: createBuildPreviewBrowserVerifier({
      repository,
      evidence,
      runner,
      now: (() => {
        let tick = 0;
        return () => new Date(1_700_000_000_000 + tick++ * 1_000);
      })(),
    }),
  };
}

describe('build preview browser verifier', () => {
  it('records passing evidence for the exact instance identity', async () => {
    const { evidence, repository, verifier } = createVerifier(passingJourney());

    const outcome = await verifier.verify(request());

    expect(outcome).toMatchObject({
      checkId: 'check-1',
      status: 'passed',
      evidenceRefs: [
        {
          container: 'build-preview-browser-evidence',
          key: 'check-1/screenshot.png',
        },
        {
          container: 'build-preview-browser-evidence',
          key: 'check-1/browser-check.json',
        },
      ],
    });
    expect(repository.created).toEqual([
      {
        buildPreviewInstanceId: 'instance-1',
        commit: COMMIT,
        artifactDigest: DIGEST,
        journeyVersion: 'full-stack-express:profile:v1',
      },
    ]);
    expect(repository.completed[0]).toMatchObject({
      id: 'check-1',
      buildPreviewInstanceId: 'instance-1',
      commit: COMMIT,
      artifactDigest: DIGEST,
      status: 'passed',
      consoleSummary: {
        errorCount: 0,
        pageErrorCount: 0,
      },
      networkSummary: {
        failureCount: 0,
      },
    });
    expect(evidence.writes.map((write) => write.name)).toEqual([
      'screenshot.png',
      'browser-check.json',
    ]);
  });

  it.each([
    [
      'console errors',
      passingJourney({ consoleErrors: ['Uncaught rendering failure'] }),
    ],
    ['page errors', passingJourney({ pageErrors: ['TypeError: broken'] })],
    [
      'failed requests',
      passingJourney({
        networkFailures: [
          {
            method: 'GET',
            path: '/api/v1/me',
            failure: 'net::ERR_FAILED',
          },
        ],
      }),
    ],
    [
      'accessibility violations',
      passingJourney({
        a11yViolations: [{ id: 'label', impact: 'critical', nodeCount: 1 }],
      }),
    ],
    ['missing screenshot', passingJourney({ screenshot: null })],
  ])('fails when the journey has %s', async (_label, journey) => {
    const { repository, verifier } = createVerifier(journey);

    await expect(verifier.verify(request())).resolves.toMatchObject({
      status: 'failed',
    });
    expect(repository.completed[0]?.status).toBe('failed');
  });

  it('records a failed check when the browser runner throws', async () => {
    const { evidence, repository, verifier } = createVerifier(
      new Error('browser process crashed')
    );

    const outcome = await verifier.verify(request());

    expect(outcome.status).toBe('failed');
    expect(repository.completed[0]).toMatchObject({
      status: 'failed',
      consoleSummary: {
        verifierError: 'Browser verification could not complete.',
      },
    });
    expect(evidence.writes.map((write) => write.name)).toEqual([
      'browser-check.json',
    ]);
    expect(evidence.writes[0]?.bytes.toString('utf8')).not.toContain(
      'browser process crashed'
    );
  });

  it('bounds and redacts stored runner findings', async () => {
    const { evidence, repository, verifier } = createVerifier(
      passingJourney({
        consoleErrors: ['Authorization: Bearer top-secret-token'],
        networkFailures: [
          {
            method: 'GET',
            path: '/api/v1/me?token=top-secret-token',
            failure: 'password=hunter2',
          },
        ],
        failure: 'secret=private-value',
      })
    );

    await verifier.verify(request());

    const serialized = evidence.writes
      .map((write) => write.bytes.toString('utf8'))
      .join('\n');
    expect(serialized).not.toContain('top-secret-token');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('private-value');
    expect(serialized).not.toContain('?token=');
    expect(repository.completed[0]?.consoleSummary).not.toEqual(
      expect.objectContaining({
        errors: expect.arrayContaining([
          expect.stringContaining('top-secret-token'),
        ]),
      })
    );
  });

  it.each(['screenshot.png', 'browser-check.json'] as const)(
    'does not record a pass when %s cannot be stored',
    async (failingName) => {
      const { repository, verifier } = createVerifier(
        passingJourney(),
        failingName
      );

      await expect(verifier.verify(request())).resolves.toMatchObject({
        status: 'failed',
      });
      expect(repository.completed[0]).toMatchObject({
        status: 'failed',
        consoleSummary: {
          verifierError: 'Browser evidence could not be stored.',
        },
      });
    }
  );

  it('rejects malformed identity and non-loopback HTTP targets before creating a row', async () => {
    const { repository, verifier } = createVerifier(passingJourney());

    await expect(
      verifier.verify({
        ...request(),
        commit: 'not-a-commit',
      })
    ).rejects.toThrow(/commit/i);
    await expect(
      verifier.verify({
        ...request(),
        targetUrl: 'http://example.com',
      })
    ).rejects.toThrow(/target/i);
    await expect(
      verifier.verify({
        ...request(),
        targetUrl: 'https://example.com',
      })
    ).rejects.toThrow(/target/i);
    expect(repository.created).toHaveLength(0);
  });
});
