import {
  createInMemorySandboxProvider,
  type InMemorySandboxProvider,
} from '../services/build/inMemorySandboxProvider';
import type {
  ProviderMutationResult,
  SandboxProvisionSpec,
} from '../services/build/buildPreviewProviderContracts';

const COMMIT = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RUNTIME_DIGEST = `sha256:${'c'.repeat(64)}`;

function provisionSpec(
  overrides: Partial<SandboxProvisionSpec> = {},
): SandboxProvisionSpec {
  return {
    correlation: {
      previewInstanceId: 'instance-1',
      buildRunId: 'run-1',
      revisionId: 'revision-1',
      revisionNumber: 1,
      validatedCommit: COMMIT,
      templateVersion: '1.0.0',
    },
    artifactDigest: DIGEST,
    runtimeBundleDigest: RUNTIME_DIGEST,
    expiresAt: '2026-11-06T03:00:00.000Z',
    policy: {
      egress: 'denied',
      maxRuntimeSeconds: 3600,
    },
    ...overrides,
  };
}

function accepted(result: ProviderMutationResult): {
  operationId: string;
  handle: string;
} {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.accepted.handle) {
    throw new Error('Expected an accepted mutation with a handle.');
  }
  return {
    operationId: result.accepted.operationId,
    handle: result.accepted.handle,
  };
}

async function provision(
  provider: InMemorySandboxProvider,
  idempotencyKey = 'instance-1:provision:1',
): Promise<{ operationId: string; handle: string }> {
  return accepted(
    await provider.provision({
      idempotencyKey,
      spec: provisionSpec(),
    }),
  );
}

describe('in-memory SandboxProvider conformance', () => {
  it('provisions an inspectable running sandbox without exposing a public URL', async () => {
    const provider = createInMemorySandboxProvider();
    const { handle } = await provision(provider);

    const inspected = await provider.inspect({ handle });

    expect(inspected.phase).toBe('succeeded');
    expect(inspected.snapshot).toMatchObject({
      lifecycle: 'running',
      applicationTarget: {
        health: {
          livenessPath: '/health/live',
          readinessPath: '/health/ready',
        },
      },
    });
    expect(inspected.snapshot?.applicationTarget?.upstreamRef).not.toMatch(
      /^https?:\/\//,
    );
  });

  it('returns the same operation and handle for concurrent equivalent retries', async () => {
    const provider = createInMemorySandboxProvider();
    const input = {
      idempotencyKey: 'instance-1:provision:1',
      spec: provisionSpec(),
    };

    const [first, second] = await Promise.all([
      provider.provision(input),
      provider.provision(input),
    ]);

    expect(first).toEqual(second);
    expect(accepted(first).handle).toBe(accepted(second).handle);
  });

  it('does not expose mutable provider state through inputs or observations', async () => {
    const provider = createInMemorySandboxProvider();
    const spec = provisionSpec();
    const { handle } = accepted(await provider.provision({
      idempotencyKey: 'instance-1:provision:1',
      spec,
    }));

    spec.policy.maxRuntimeSeconds = 1;
    const first = await provider.inspect({ handle });
    if (!first.snapshot) throw new Error('Expected an inspectable sandbox.');
    first.snapshot.lifecycle = 'terminated';
    first.snapshot.spec.policy.maxRuntimeSeconds = 2;

    const second = await provider.inspect({ handle });
    expect(second.snapshot).toMatchObject({
      lifecycle: 'running',
      spec: {
        policy: { maxRuntimeSeconds: 3600 },
      },
    });
  });

  it('rejects reuse of an idempotency key with a different payload', async () => {
    const provider = createInMemorySandboxProvider();
    await provider.provision({
      idempotencyKey: 'instance-1:provision:1',
      spec: provisionSpec(),
    });

    const conflict = await provider.provision({
      idempotencyKey: 'instance-1:provision:1',
      spec: provisionSpec({
        artifactDigest: `sha256:${'d'.repeat(64)}`,
      }),
    });

    expect(conflict).toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
  });

  it('supports renew, suspend, resume, and destroy as idempotent lifecycle operations', async () => {
    const provider = createInMemorySandboxProvider();
    const { handle } = await provision(provider);

    const renewed = await provider.renew({
      idempotencyKey: 'instance-1:renew:1',
      handle,
      expiresAt: '2026-11-06T04:00:00.000Z',
    });
    expect(renewed.ok).toBe(true);

    await provider.suspend({
      idempotencyKey: 'instance-1:suspend:1',
      handle,
    });
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'suspended',
    );

    await provider.resume({
      idempotencyKey: 'instance-1:resume:1',
      handle,
    });
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'running',
    );

    const destroyInput = {
      idempotencyKey: 'instance-1:destroy:1',
      handle,
    };
    const firstDestroy = await provider.destroy(destroyInput);
    const secondDestroy = await provider.destroy(destroyInput);
    expect(secondDestroy).toEqual(firstDestroy);
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'terminated',
    );
  });

  it('returns a structured not-found observation for an unknown handle', async () => {
    const provider = createInMemorySandboxProvider();

    await expect(provider.inspect({ handle: 'sandbox_missing' })).resolves.toMatchObject({
      phase: 'unknown',
      snapshot: null,
      error: { code: 'not_found', retryable: false },
    });
  });

  it('reports a stalled provision as timed out', async () => {
    let nowMs = Date.parse('2026-11-06T02:00:00.000Z');
    const provider = createInMemorySandboxProvider({
      now: () => new Date(nowMs),
      stallProvisioning: true,
      provisioningTimeoutMs: 1_000,
    });
    const { handle } = await provision(provider);
    nowMs += 1_001;

    const inspected = await provider.inspect({ handle });

    expect(inspected).toMatchObject({
      phase: 'failed',
      snapshot: {
        lifecycle: 'failed',
        failureCode: 'timeout',
      },
    });
  });
});
