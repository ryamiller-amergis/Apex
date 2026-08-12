/**
 * FEAT-004 / TBI-004 thin background worker host.
 */
import path from 'path';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type { AiRunIngestBody } from '../../shared/types/aiRunIngest';
import type { CursorExecutionRun } from '../services/cursorExecutionCore';
import {
  AI_RUNS_DEFAULT_HEARTBEAT_MS,
  AiRunFenceConflictError,
  createAiRunsWorker,
  openLocalCheckout,
  resolveAiRunsHeartbeatMs,
} from '../services/aiRunsWorker';

const snapshot: Readonly<ExecutionSnapshot> = Object.freeze({
  prompt: 'Implement only the frozen requirement.',
  model: 'claude-sonnet-4-5',
  workspaceRef: 'C:\\shared\\runs\\run-1',
  workflowClass: 'development',
  skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
  projectId: 'project-1',
  threadId: 'thread-1',
});

const dispatch = {
  runId: 'run-1',
  dispatchMessageId: 'dispatch-current',
} as const;

function createRun(options: {
  streamError?: Error;
  events?: Array<Record<string, unknown>>;
} = {}): CursorExecutionRun & { cancel: jest.Mock } {
  return {
    supports: (capability) => capability === 'stream',
    stream: async function* () {
      for (const event of options.events ?? [{
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      }]) {
        yield event as never;
      }
      if (options.streamError) throw options.streamError;
    },
    wait: jest.fn().mockResolvedValue({ status: 'finished', result: 'done' }),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
}

function setup(options: {
  run?: ReturnType<typeof createRun>;
  postIngest?: (
    projectId: string,
    runId: string,
    body: AiRunIngestBody,
  ) => Promise<{ ok: boolean; cancelRequested: boolean }>;
} = {}) {
  const order: string[] = [];
  const run = options.run ?? createRun();
  const dispose = jest.fn(async () => {
    order.push('dispose');
  });
  const postIngest = jest.fn(options.postIngest ?? (async (
    _projectId: string,
    _runId: string,
    body: AiRunIngestBody,
  ) => {
    order.push(`ingest:${body.kind}${body.kind === 'terminal' ? `:${body.status}` : ''}`);
    return { ok: true, cancelRequested: false };
  }));
  const flushArtifacts = jest.fn(async () => {
    order.push('flush');
  });
  const openCheckout = jest.fn(async () => {
    order.push('open');
    return { listDir: jest.fn() };
  });
  const createExecution = jest.fn(async () => {
    order.push('create');
    return { run, dispose };
  });
  const worker = createAiRunsWorker({
    getBootstrap: jest.fn().mockResolvedValue({
      projectId: 'project-1',
      run: {
        id: 'run-1',
        threadId: 'thread-1',
        projectId: 'project-1',
        lane: 'background',
        status: 'dispatched',
        dispatchMessageId: 'dispatch-current',
        executionSnapshot: snapshot,
        cancelRequested: false,
      },
    }),
    openCheckout,
    createExecution,
    postIngest,
    flushArtifacts,
    heartbeatIntervalMs: 0,
    sourceInstance: 'worker-test',
  });

  return {
    worker,
    order,
    run,
    dispose,
    postIngest,
    flushArtifacts,
    openCheckout,
    createExecution,
  };
}

describe('aiRunsWorker host', () => {
  it('TBI-004 DoD-3 / BR-010 / AC-0 / VT-01: flushes after core success and before completed terminal', async () => {
    const ctx = setup();

    await ctx.worker.execute(dispatch);

    expect(ctx.order).toEqual([
      'ingest:heartbeat',
      'open',
      'create',
      'ingest:progress',
      'flush',
      'ingest:terminal:completed',
      'dispose',
    ]);
    expect(ctx.postIngest).toHaveBeenLastCalledWith(
      'project-1',
      'run-1',
      expect.objectContaining({
        kind: 'terminal',
        status: 'completed',
        artifactsFlushed: true,
      }),
    );
  });

  it('TBI-004 DoD-4: safely flushes execution-failure artifacts before failed terminal', async () => {
    const ctx = setup({
      run: createRun({ streamError: new Error('execution failed') }),
    });

    await ctx.worker.execute(dispatch);

    expect(ctx.order).toEqual([
      'ingest:heartbeat',
      'open',
      'create',
      'ingest:progress',
      'flush',
      'ingest:terminal:failed',
      'dispose',
    ]);
    expect(ctx.postIngest).toHaveBeenLastCalledWith(
      'project-1',
      'run-1',
      expect.objectContaining({
        kind: 'terminal',
        status: 'failed',
        artifactsFlushed: true,
        detail: 'Worker execution failed: execution failed',
      }),
    );
  });

  it('surfaces checkout/open failures in the failed terminal detail', async () => {
    const ctx = setup();
    ctx.openCheckout.mockRejectedValueOnce(
      Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'LOCAL_READ_UNAVAILABLE',
      }),
    );

    await ctx.worker.execute(dispatch);

    expect(ctx.postIngest).toHaveBeenLastCalledWith(
      'project-1',
      'run-1',
      expect.objectContaining({
        kind: 'terminal',
        status: 'failed',
        detail:
          'Worker execution failed: LOCAL_READ_UNAVAILABLE: ENOENT: no such file or directory',
      }),
    );
  });

  it('TBI-004 DoD-2 / PBI-004 AC-2 / VT-04: cancellation disposes, acknowledges, and never completes', async () => {
    const ctx = setup({
      postIngest: async (_projectId, _runId, body) => ({
        ok: true,
        cancelRequested: body.kind === 'progress',
      }),
    });

    await ctx.worker.execute(dispatch);

    expect(ctx.run.cancel).toHaveBeenCalledTimes(1);
    expect(ctx.dispose).toHaveBeenCalled();
    expect(ctx.postIngest).toHaveBeenCalledWith(
      'project-1',
      'run-1',
      expect.objectContaining({ kind: 'cancel_ack' }),
    );
    expect(ctx.postIngest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ kind: 'terminal', status: 'completed' }),
    );
    expect(ctx.flushArtifacts).not.toHaveBeenCalled();
  });

  it('TBI-004 DoD-2 / PBI-004 AC-3 / VT-06: stale heartbeat aborts before checkout or later callbacks', async () => {
    const ctx = setup({
      postIngest: async () => {
        throw new AiRunFenceConflictError('dispatch mismatch');
      },
    });

    await expect(ctx.worker.execute(dispatch)).rejects.toBeInstanceOf(
      AiRunFenceConflictError,
    );

    expect(ctx.openCheckout).not.toHaveBeenCalled();
    expect(ctx.createExecution).not.toHaveBeenCalled();
    expect(ctx.flushArtifacts).not.toHaveBeenCalled();
    expect(ctx.postIngest).toHaveBeenCalledTimes(1);
  });

  it('TBI-004 DoD-2 / PBI-004 AC-3 / VT-06: stale progress cancels and suppresses flush and terminal', async () => {
    const ctx = setup({
      postIngest: async (_projectId, _runId, body) => {
        if (body.kind === 'progress') {
          throw new AiRunFenceConflictError('dispatch mismatch');
        }
        return { ok: true, cancelRequested: false };
      },
    });

    await expect(ctx.worker.execute(dispatch)).rejects.toBeInstanceOf(
      AiRunFenceConflictError,
    );

    expect(ctx.run.cancel).toHaveBeenCalled();
    expect(ctx.dispose).toHaveBeenCalled();
    expect(ctx.flushArtifacts).not.toHaveBeenCalled();
    expect(ctx.postIngest).toHaveBeenCalledTimes(2);
  });
});

describe('aiRunsWorker local checkout and heartbeat contracts', () => {
  it('TBI-004 DoD-1 / VT-07: missing checkout fails closed with LOCAL_READ_UNAVAILABLE', async () => {
    const unavailable = path.join(
      process.cwd(),
      `.missing-ai-run-checkout-${Date.now()}`,
    );

    await expect(openLocalCheckout(snapshot, unavailable)).rejects.toMatchObject({
      code: 'LOCAL_READ_UNAVAILABLE',
    });
  });

  it('TBI-004 performance NFR: defaults heartbeat interval to 15 seconds', () => {
    const previous = process.env.AI_RUNS_HEARTBEAT_INTERVAL_MS;
    delete process.env.AI_RUNS_HEARTBEAT_INTERVAL_MS;
    try {
      expect(resolveAiRunsHeartbeatMs()).toBe(AI_RUNS_DEFAULT_HEARTBEAT_MS);
      expect(AI_RUNS_DEFAULT_HEARTBEAT_MS).toBe(15_000);
    } finally {
      if (previous !== undefined) {
        process.env.AI_RUNS_HEARTBEAT_INTERVAL_MS = previous;
      }
    }
  });
});
