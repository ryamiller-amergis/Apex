import {
  PlaybookRunActionConflictError,
  PlaybookRunActionForbiddenError,
  createPlaybookRunActionService,
} from '../services/playbookRunActionService';

const GRAPH = {
  nodes: [{ id: 'agent', stepType: 'cursor-agent', config: { skillPath: 's', prompt: 'p' } }],
  edges: [],
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    project: 'Apex',
    initiatorUserId: 'owner',
    definitionVersionId: 'version-1',
    status: 'running',
    graph: GRAPH,
    steps: [
      {
        id: 'step-run-1',
        stepId: 'agent',
        stepType: 'cursor-agent',
        status: 'failed_retryable',
      },
    ],
    ...overrides,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const deps = {
    loadContext: jest.fn().mockResolvedValue(context()),
    getUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
    cancelEngine: jest.fn().mockResolvedValue(undefined),
    cancelRows: jest.fn().mockResolvedValue(true),
    prepareRetry: jest.fn().mockResolvedValue(true),
    retryEngine: jest.fn().mockResolvedValue({ endedAs: 'suspended' }),
    restoreRetryable: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { deps, service: createPlaybookRunActionService(deps as never) };
}

describe('TBI-037 run actions', () => {
  it('VT-12 lets the initiator cancel without playbooks:admin and records the actor', async () => {
    const { deps, service } = harness();

    await expect(
      service.cancel({ runId: 'run-1', project: 'Apex', actorUserId: 'owner', reason: 'stop' })
    ).resolves.toEqual({ runId: 'run-1', status: 'cancelled', outcome: 'cancelled' });

    expect(deps.getUserPermissions).not.toHaveBeenCalled();
    expect(deps.cancelEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: 'Apex',
        initiatorUserId: 'owner',
        cancelledByUserId: 'owner',
        graph: GRAPH,
      })
    );
    expect(deps.cancelRows).toHaveBeenCalledWith('run-1');
  });

  it('VT-13 lets a live project admin act for another initiator', async () => {
    const { deps, service } = harness({
      getUserPermissions: jest.fn().mockResolvedValue(new Set(['playbooks:admin'])),
    });

    await service.retry({
      runId: 'run-1',
      stepRunId: 'step-run-1',
      project: 'Apex',
      actorUserId: 'admin',
    });

    expect(deps.getUserPermissions).toHaveBeenCalledWith('admin', 'Apex');
    expect(deps.retryEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        stepRunId: 'step-run-1',
        retriedByUserId: 'admin',
        initiatorUserId: 'owner',
        definitionVersionId: 'version-1',
      })
    );
  });

  it('VT-14 refuses a stranger before engine or database mutation', async () => {
    const { deps, service } = harness();

    await expect(
      service.cancel({ runId: 'run-1', project: 'Apex', actorUserId: 'stranger' })
    ).rejects.toThrow(PlaybookRunActionForbiddenError);

    expect(deps.cancelEngine).not.toHaveBeenCalled();
    expect(deps.cancelRows).not.toHaveBeenCalled();
  });

  it('VT-15 scopes admin permission lookup to the run project', async () => {
    const { deps, service } = harness();

    await expect(
      service.retry({
        runId: 'run-1',
        stepRunId: 'step-run-1',
        project: 'Apex',
        actorUserId: 'other-project-admin',
      })
    ).rejects.toThrow(PlaybookRunActionForbiddenError);

    expect(deps.getUserPermissions).toHaveBeenCalledWith('other-project-admin', 'Apex');
    expect(deps.retryEngine).not.toHaveBeenCalled();
  });

  it('VT-16 makes already-cancelled idempotent and conflicts other terminals', async () => {
    const cancelled = harness({ loadContext: jest.fn().mockResolvedValue(context({ status: 'cancelled' })) });
    await expect(
      cancelled.service.cancel({ runId: 'run-1', project: 'Apex', actorUserId: 'owner' })
    ).resolves.toEqual({
      runId: 'run-1',
      status: 'cancelled',
      outcome: 'already-cancelled',
    });
    expect(cancelled.deps.cancelEngine).not.toHaveBeenCalled();

    for (const status of ['completed', 'failed', 'expired']) {
      const terminal = harness({
        loadContext: jest.fn().mockResolvedValue(context({ status })),
      });
      await expect(
        terminal.service.cancel({ runId: 'run-1', project: 'Apex', actorUserId: 'owner' })
      ).rejects.toThrow(PlaybookRunActionConflictError);
      expect(terminal.deps.cancelEngine).not.toHaveBeenCalled();
    }
  });

  it('VT-17 retries the same run, version, initiator and node exactly once', async () => {
    const { deps, service } = harness();

    await expect(
      service.retry({
        runId: 'run-1',
        stepRunId: 'step-run-1',
        project: 'Apex',
        actorUserId: 'owner',
      })
    ).resolves.toEqual({
      runId: 'run-1',
      stepRunId: 'step-run-1',
      status: 'running',
      outcome: 'retried',
    });

    expect(deps.prepareRetry).toHaveBeenCalledTimes(1);
    expect(deps.retryEngine).toHaveBeenCalledTimes(1);
  });

  it('VT-17 restores failed_retryable with the new reason when execution fails', async () => {
    const { deps, service } = harness({
      retryEngine: jest.fn().mockResolvedValue({
        endedAs: 'failed',
        error: new Error('adapter failed again'),
      }),
    });

    await expect(
      service.retry({
        runId: 'run-1',
        stepRunId: 'step-run-1',
        project: 'Apex',
        actorUserId: 'owner',
      })
    ).rejects.toThrow('adapter failed again');
    expect(deps.restoreRetryable).toHaveBeenCalledWith(
      'run-1',
      'step-run-1',
      'adapter failed again'
    );
  });

  it('VT-18 rejects a stale or non-retryable step before mutation', async () => {
    for (const steps of [
      [{ ...context().steps[0], id: 'new-current' }],
      [{ ...context().steps[0], status: 'failed' }],
    ]) {
      const { deps, service } = harness({
        loadContext: jest.fn().mockResolvedValue(context({ steps })),
      });
      await expect(
        service.retry({
          runId: 'run-1',
          stepRunId: 'step-run-1',
          project: 'Apex',
          actorUserId: 'owner',
        })
      ).rejects.toThrow(PlaybookRunActionConflictError);
      expect(deps.prepareRetry).not.toHaveBeenCalled();
      expect(deps.retryEngine).not.toHaveBeenCalled();
    }
  });
});
