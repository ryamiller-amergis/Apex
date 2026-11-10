import { createInMemoryEditablePreviewSessionProvider } from '../services/build/inMemoryEditablePreviewSessionProvider';
import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
  evaluateEditablePreviewReadiness,
  type EditablePreviewSessionProvider,
  type EditablePreviewSessionSpec,
  type ProviderMutationResult,
} from '../services/build/buildPreviewProviderContracts';

const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const NOW = '2027-11-06T17:00:00.000Z';

function createProvider() {
  return createInMemoryEditablePreviewSessionProvider({
    now: () => new Date(NOW),
  });
}

function sessionSpec(): EditablePreviewSessionSpec {
  return {
    contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
    correlation: {
      sessionId: 'studio-session-1',
      buildRunId: 'build-1',
      baseRevisionId: 'revision-1',
      draftRevisionId: 'revision-2',
      revisionNumber: 2,
      baseCommit: 'b'.repeat(40),
      templateVersion: '1.0.0',
    },
    source: {
      snapshotDigest: SOURCE_DIGEST,
      snapshotRef: 'artifact:source-snapshot-1',
    },
    developmentManifestDigest: `sha256:${'c'.repeat(64)}`,
    databaseGrantRef: 'grant:preview-database-1',
    expiresAt: '2027-11-06T18:00:00.000Z',
    policy: {
      egress: 'denied',
      maxRuntimeSeconds: 28_800,
      writableWorkspace: true,
    },
    requiredTransports: EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  };
}

function accepted(result: ProviderMutationResult): string {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.accepted.handle) {
    throw new Error('Expected an accepted mutation with a session handle.');
  }
  return result.accepted.handle;
}

async function start(
  provider: EditablePreviewSessionProvider
): Promise<string> {
  return accepted(
    await provider.start({
      idempotencyKey: 'studio-session-1:start:1',
      spec: sessionSpec(),
    })
  );
}

describe('in-memory EditablePreviewSessionProvider conformance', () => {
  it('materializes an inspectable writable session with HTTP, WebSocket, and Vite HMR', async () => {
    const provider = createProvider();
    const handle = await start(provider);

    const inspected = await provider.inspect({ handle });

    expect(inspected.phase).toBe('succeeded');
    expect(inspected.snapshot).not.toBeNull();
    expect(evaluateEditablePreviewReadiness(inspected.snapshot!)).toEqual({
      ready: true,
    });
    expect(JSON.stringify(inspected.snapshot)).not.toMatch(
      /https?:\/\/|file:\/|[a-z]:\\/i
    );
  });

  it('applies an idempotent change set to the same session and records a reconstructible workspace version', async () => {
    const provider = createProvider();
    const handle = await start(provider);
    const input = {
      idempotencyKey: 'studio-session-1:change:1',
      handle,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: `sha256:${'d'.repeat(64)}`,
        contentRef: 'artifact:change-set-1',
      },
    };

    const first = await provider.applyChangeSet(input);
    const replay = await provider.applyChangeSet(input);

    expect(replay).toEqual(first);
    expect((await provider.inspect({ handle })).snapshot?.workspace).toEqual({
      writable: true,
      version: 1,
      baseSnapshotDigest: SOURCE_DIGEST,
      appliedChangeSets: [input.changeSet],
    });
  });

  it('rejects stale workspace writes and changed idempotency-key replays', async () => {
    const provider = createProvider();
    const handle = await start(provider);
    const firstChange = {
      idempotencyKey: 'studio-session-1:change:1',
      handle,
      expectedWorkspaceVersion: 0,
      changeSet: {
        digest: `sha256:${'d'.repeat(64)}`,
        contentRef: 'artifact:change-set-1',
      },
    };
    await provider.applyChangeSet(firstChange);

    await expect(
      provider.applyChangeSet({
        ...firstChange,
        idempotencyKey: 'studio-session-1:change:2',
        expectedWorkspaceVersion: 0,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
    await expect(
      provider.applyChangeSet({
        ...firstChange,
        changeSet: {
          digest: `sha256:${'e'.repeat(64)}`,
          contentRef: 'artifact:change-set-2',
        },
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'conflict', retryable: false },
    });
  });

  it('supports portable renew, suspend, resume, task, and destroy operations without exposing provider commands', async () => {
    const provider = createProvider();
    const handle = await start(provider);

    expect(
      (
        await provider.runTask({
          idempotencyKey: 'studio-session-1:task:1',
          handle,
          expectedWorkspaceVersion: 0,
          task: 'typecheck',
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await provider.renew({
          idempotencyKey: 'studio-session-1:renew:1',
          handle,
          expiresAt: '2027-11-06T19:00:00.000Z',
        })
      ).ok
    ).toBe(true);
    await provider.suspend({
      idempotencyKey: 'studio-session-1:suspend:1',
      handle,
    });
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'suspended'
    );
    await provider.resume({
      idempotencyKey: 'studio-session-1:resume:1',
      handle,
    });
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'ready'
    );
    await provider.destroy({
      idempotencyKey: 'studio-session-1:destroy:1',
      handle,
    });
    expect((await provider.inspect({ handle })).snapshot?.lifecycle).toBe(
      'terminated'
    );
  });
});
