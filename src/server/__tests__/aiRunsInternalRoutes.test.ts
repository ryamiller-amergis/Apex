/**
 * FEAT-004 / TBI-005 session-free AI runner ingest route.
 */
const mockDbSelect = jest.fn();
const mockVerifyProxyToken = jest.fn();
const mockInvokeToolProxy = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
  },
}));

jest.mock('../services/aiRunIngestService', () => {
  class AiRunIngestError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    AiRunIngestError,
    getBootstrap: jest.fn(),
    ingest: jest.fn(),
  };
});

jest.mock('../services/interactiveToolProxyToken', () => ({
  InteractiveToolProxyTokenError: class extends Error {},
  verifyInteractiveToolProxyToken: (...args: unknown[]) =>
    mockVerifyProxyToken(...args),
}));

jest.mock('../services/interactiveToolProxyService', () => ({
  InteractiveToolProxyError: class extends Error {
    status = 502;
  },
  invokeInteractiveToolProxy: (...args: unknown[]) =>
    mockInvokeToolProxy(...args),
}));

import express from 'express';
import request from 'supertest';
import aiRunsInternalRouter from '../routes/aiRunsInternal';
import * as aiRunIngestService from '../services/aiRunIngestService';

const mockIngest = aiRunIngestService.ingest as jest.MockedFunction<
  typeof aiRunIngestService.ingest
>;
const mockGetBootstrap = aiRunIngestService.getBootstrap as jest.MockedFunction<
  typeof aiRunIngestService.getBootstrap
>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/ai-runs', aiRunsInternalRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AI_RUNS_RUNNER_CALLBACK_TOKEN = 'runner-secret';
  process.env.SESSION_SECRET = 'proxy-test-secret';
  mockIngest.mockResolvedValue({
    cancelRequested: false,
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      projectId: 'project-1',
      status: 'running',
      dispatchMessageId: 'dispatch-1',
      cancelRequested: false,
    },
  } as Awaited<ReturnType<typeof aiRunIngestService.ingest>>);
  mockGetBootstrap.mockResolvedValue({
    projectId: 'project-1',
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      projectId: 'project-1',
      lane: 'background',
      status: 'dispatched',
      dispatchMessageId: 'dispatch-1',
      executionSnapshot: {
        prompt: 'Frozen prompt',
        model: 'claude-sonnet-4-5',
        workspaceRef: 'C:\\shared\\runs\\run-1',
        workflowClass: 'development',
        skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
        projectId: 'project-1',
        threadId: 'thread-1',
      },
    },
  } as Awaited<ReturnType<typeof aiRunIngestService.getBootstrap>>);
});

describe('GET /api/internal/ai-runs/:runId/bootstrap', () => {
  it('TBI-004 bootstrap seam: requires runner authentication', async () => {
    const res = await request(buildApp())
      .get('/api/internal/ai-runs/run-1/bootstrap')
      .query({ dispatchMessageId: 'dispatch-1' });

    expect(res.status).toBe(401);
    expect(mockGetBootstrap).not.toHaveBeenCalled();
  });

  it('TBI-004 DoD-1: returns the fenced project-confidential snapshot', async () => {
    const res = await request(buildApp())
      .get('/api/internal/ai-runs/run-1/bootstrap')
      .set('Authorization', 'Bearer runner-secret')
      .query({ dispatchMessageId: 'dispatch-1' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      projectId: 'project-1',
      run: expect.objectContaining({
        id: 'run-1',
        executionSnapshot: expect.objectContaining({
          prompt: 'Frozen prompt',
          workspaceRef: 'C:\\shared\\runs\\run-1',
        }),
      }),
    }));
    expect(mockGetBootstrap).toHaveBeenCalledWith('run-1', 'dispatch-1');
  });

  it.each([
    ['AI_RUN_DISPATCH_MISMATCH', 409],
    ['AI_RUN_ILLEGAL_TRANSITION', 409],
    ['AI_RUN_NOT_FOUND', 404],
  ])('TBI-004 bootstrap seam: maps %s to HTTP %i', async (code, status) => {
    mockGetBootstrap.mockRejectedValue(
      new aiRunIngestService.AiRunIngestError('bootstrap rejected', code as never),
    );

    const res = await request(buildApp())
      .get('/api/internal/ai-runs/run-1/bootstrap')
      .set('Authorization', 'Bearer runner-secret')
      .query({ dispatchMessageId: 'dispatch-1' });

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('POST /api/internal/ai-runs/:projectId/:runId/ingest', () => {
  it('TBI-005 DoD-0: rejects missing runner identity without ingest mutation', async () => {
    const res = await request(buildApp())
      .post('/api/internal/ai-runs/project-1/run-1/ingest')
      .send({ dispatchMessageId: 'dispatch-1', kind: 'heartbeat' });

    expect(res.status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it.each([
    { dispatchMessageId: 'dispatch-1', kind: 'heartbeat' },
    {
      dispatchMessageId: 'dispatch-1',
      kind: 'progress',
      phase: 'testing',
      status: 'running',
      detail: 'Running tests',
    },
    {
      dispatchMessageId: 'dispatch-1',
      kind: 'cancel_ack',
      detail: 'Worker stopped',
    },
    {
      dispatchMessageId: 'dispatch-1',
      kind: 'terminal',
      status: 'completed',
      artifactsFlushed: true,
    },
  ])('TBI-005 DoD-0: accepts authenticated $kind ingest', async (body) => {
    const res = await request(buildApp())
      .post('/api/internal/ai-runs/project-1/run-1/ingest')
      .set('Authorization', 'Bearer runner-secret')
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      cancelRequested: false,
    }));
    expect(mockIngest).toHaveBeenCalledWith('project-1', 'run-1', body);
  });

  it.each([
    ['AI_RUN_DISPATCH_MISMATCH', 409],
    ['AI_RUN_ILLEGAL_TRANSITION', 409],
    ['AI_RUN_NOT_FOUND', 404],
    ['AI_RUN_ARTIFACTS_NOT_FLUSHED', 422],
  ])('PBI-004 AC-3: maps %s to HTTP %i', async (code, status) => {
    mockIngest.mockRejectedValue(
      new aiRunIngestService.AiRunIngestError('ingest rejected', code as never),
    );

    const res = await request(buildApp())
      .post('/api/internal/ai-runs/project-1/run-1/ingest')
      .set('Authorization', 'Bearer runner-secret')
      .send({ dispatchMessageId: 'dispatch-1', kind: 'heartbeat' });

    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
  });
});

describe('POST /api/internal/ai-runs/:runId/tools/:serverName active attempt', () => {
  function chainSelect(results: unknown[][]) {
    let call = 0;
    mockDbSelect.mockImplementation(() => {
      const rows = results[call] ?? [];
      call += 1;
      const limit = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ limit });
      const from = jest.fn().mockReturnValue({ where });
      return { from };
    });
  }

  it('returns 409 when the attempt is not queued|dispatched|running', async () => {
    mockVerifyProxyToken.mockReturnValue({
      runId: 'run-1',
      attemptId: 'attempt-1',
      dispatchMessageId: 'dispatch-1',
      serverName: 'ado-skills',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    chainSelect([
      [
        {
          id: 'run-1',
          transportVersion: 'dapr-actor-v2',
          dispatchMessageId: 'dispatch-1',
        },
      ],
      [
        {
          id: 'attempt-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
          status: 'completed',
          specSnapshot: {
            schemaVersion: 1,
            kind: 'interactive-turn',
            turnId: '10000000-0000-4000-8000-000000000001',
            threadId: '10000000-0000-4000-8000-000000000002',
            userId: '10000000-0000-4000-8000-000000000003',
            projectId: 'project-1',
            interactiveClass: 'fast',
            workflowClass: 'home-chat',
            model: 'm',
            effort: null,
            skill: null,
            currentMessage: {
              id: '10000000-0000-4000-8000-000000000001',
              text: 'x',
              hidden: false,
              attachments: [],
            },
            transcript: [],
            grounding: null,
            mcpServers: [
              {
                kind: 'internal-proxy',
                serverName: 'ado-skills',
                enableRepoBrowse: true,
              },
            ],
            toolGrant: null,
            currentPrompt: 'x',
            recreationPrompt: 'x',
            deadlines: {
              absoluteTurnMs: 300_000,
              repositoryPreparationMs: null,
              firstEventMs: 30_000,
              toolCallMs: 60_000,
            },
          },
        },
      ],
    ]);

    const res = await request(buildApp())
      .post('/api/internal/ai-runs/run-1/tools/ado-skills')
      .query({ token: 'signed-token' })
      .send({ method: 'tools/call' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AI_RUN_DISPATCH_MISMATCH');
    expect(res.body.error).toMatch(/active attempt/i);
    expect(mockInvokeToolProxy).not.toHaveBeenCalled();
  });
});
