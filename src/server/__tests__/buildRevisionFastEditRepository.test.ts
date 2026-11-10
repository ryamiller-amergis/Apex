import {
  createInMemoryBuildRevisionFastEditStore,
  createBuildRevisionFastEditRepository,
  type BeginBuildRevisionFastEditAttemptResult,
} from '../services/build/buildRevisionFastEditRepository';

const BASE_COMMIT = 'a'.repeat(40);
const BASE_DIGEST = `sha256:${'b'.repeat(64)}`;
const CHANGE_DIGEST = `sha256:${'c'.repeat(64)}`;

function requireAttempt(
  result: BeginBuildRevisionFastEditAttemptResult,
) {
  if (result.status === 'active_conflict') {
    throw new Error('Expected a fast-edit attempt.');
  }
  return result.attempt;
}

function beginInput(overrides: Record<string, unknown> = {}) {
  return {
    buildRunId: 'build-1',
    buildRevisionId: 'revision-2',
    idempotencyKey: 'revision-2:request-1',
    requestDigest: `sha256:${'d'.repeat(64)}`,
    baseCommit: BASE_COMMIT,
    baseSnapshot: {
      digest: BASE_DIGEST,
      ref: 'artifact:fast-edit-base:build-1',
    },
    expectedWorkspaceVersion: 3,
    requestedAt: '2026-11-06T18:00:00.000Z',
    expiresAt: '2026-11-06T20:00:00.000Z',
    ...overrides,
  };
}

describe('build revision fast-edit repository', () => {
  it('returns the original attempt for an idempotent retry', async () => {
    const repository = createBuildRevisionFastEditRepository(
      createInMemoryBuildRevisionFastEditStore(),
    );

    const first = await repository.beginAttempt(beginInput());
    const retry = await repository.beginAttempt(beginInput());
    const firstAttempt = requireAttempt(first);

    expect(first.status).toBe('created');
    expect(retry).toMatchObject({
      status: 'existing',
      attempt: {
        id: firstAttempt.id,
        recordVersion: 1,
        status: 'classify',
      },
    });
  });

  it('allows only one active edit per build', async () => {
    const repository = createBuildRevisionFastEditRepository(
      createInMemoryBuildRevisionFastEditStore(),
    );
    const first = await repository.beginAttempt(beginInput());
    const firstAttempt = requireAttempt(first);

    const conflict = await repository.beginAttempt(
      beginInput({
        buildRevisionId: 'revision-3',
        idempotencyKey: 'revision-3:request-1',
      }),
    );

    expect(conflict).toEqual({
      status: 'active_conflict',
      activeAttemptId: firstAttempt.id,
    });
  });

  it('rejects a stale workspace version without appending a change set', async () => {
    const repository = createBuildRevisionFastEditRepository(
      createInMemoryBuildRevisionFastEditStore(),
    );
    const started = await repository.beginAttempt(beginInput());
    const attempt = requireAttempt(started);

    const result = await repository.appendChangeSet({
      attemptId: attempt.id,
      idempotencyKey: 'revision-2:change-1',
      kind: 'edit',
      artifact: {
        digest: CHANGE_DIGEST,
        ref: 'artifact:fast-edit-change:revision-2',
      },
      expectedWorkspaceVersion: 2,
      appliedWorkspaceVersion: 3,
    });

    expect(result).toEqual({
      status: 'stale_workspace',
      currentWorkspaceVersion: 3,
    });
    await expect(
      repository.loadRecoveryPlan(attempt.id),
    ).resolves.toMatchObject({ orderedChangeSets: [] });
  });

  it('reconstructs a session from its base snapshot and ordered change sets after restart', async () => {
    const store = createInMemoryBuildRevisionFastEditStore();
    const firstProcess = createBuildRevisionFastEditRepository(store);
    const started = await firstProcess.beginAttempt(beginInput());
    const attempt = requireAttempt(started);

    await firstProcess.appendChangeSet({
      attemptId: attempt.id,
      idempotencyKey: 'revision-2:change-1',
      kind: 'edit',
      artifact: {
        digest: CHANGE_DIGEST,
        ref: 'artifact:fast-edit-change:revision-2',
      },
      expectedWorkspaceVersion: 3,
      appliedWorkspaceVersion: 4,
    });

    const restartedProcess = createBuildRevisionFastEditRepository(store);
    const recovery = await restartedProcess.loadRecoveryPlan(
      attempt.id,
    );

    expect(recovery).toMatchObject({
      baseSnapshot: beginInput().baseSnapshot,
      attempt: { appliedWorkspaceVersion: 4 },
      orderedChangeSets: [
        {
          sequence: 1,
          expectedWorkspaceVersion: 3,
          appliedWorkspaceVersion: 4,
        },
      ],
    });
  });

  it('rejects provider URLs and host paths in persisted artifacts', async () => {
    const repository = createBuildRevisionFastEditRepository(
      createInMemoryBuildRevisionFastEditStore(),
    );

    await expect(
      repository.beginAttempt(
        beginInput({
          baseSnapshot: {
            digest: BASE_DIGEST,
            ref: 'file:///tmp/build-1',
          },
        }),
      ),
    ).rejects.toThrow('provider-neutral');
  });

  it('clears the previous error when a failed edit is retried', async () => {
    const repository = createBuildRevisionFastEditRepository(
      createInMemoryBuildRevisionFastEditStore(),
    );
    const started = await repository.beginAttempt(beginInput());
    const initial = requireAttempt(started);
    const editing = await repository.transitionAttempt({
      attemptId: initial.id,
      expectedRecordVersion: initial.recordVersion,
      to: 'edit',
      route: 'fast_edit',
    });
    if (editing.status !== 'updated') throw new Error('Expected edit state.');
    const failed = await repository.transitionAttempt({
      attemptId: initial.id,
      expectedRecordVersion: editing.attempt.recordVersion,
      to: 'failed',
      failureCode: 'fast_edit_failed',
      failureMessage: 'Previous failure',
    });
    if (failed.status !== 'updated') throw new Error('Expected failed state.');

    const retry = await repository.transitionAttempt({
      attemptId: initial.id,
      expectedRecordVersion: failed.attempt.recordVersion,
      to: 'edit',
      route: 'fast_edit',
    });

    expect(retry).toMatchObject({
      status: 'updated',
      attempt: {
        status: 'edit',
        failureCode: null,
        failureMessage: null,
      },
    });
  });
});
