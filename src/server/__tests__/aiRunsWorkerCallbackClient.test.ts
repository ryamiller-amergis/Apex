import {
  AiRunCallbackError,
  AiRunFenceConflictError,
  createAiRunsCallbackClient,
} from '../services/aiRunsWorker';

function response(
  status: number,
  body: unknown,
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('aiRunsWorker callback client', () => {
  it('TBI-004 bootstrap contract: fetches by only runId and dispatchMessageId', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {
      projectId: 'project-1',
      run: { id: 'run-1' },
    }));
    const client = createAiRunsCallbackClient({
      callbackBaseUrl: 'https://apex.example/',
      getToken: jest.fn().mockResolvedValue('token'),
      fetchImpl: fetchImpl as never,
    });

    await client.getBootstrap({
      runId: 'run/1',
      dispatchMessageId: 'dispatch 1',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://apex.example/api/internal/ai-runs/run%2F1/bootstrap?dispatchMessageId=dispatch+1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      }),
    );
  });

  it('TBI-004 DoD-2 / AC-3 / VT-06: classifies dispatch mismatch as a distinct fence conflict', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(409, {
      code: 'AI_RUN_DISPATCH_MISMATCH',
      error: 'dispatch mismatch',
    }));
    const client = createAiRunsCallbackClient({
      callbackBaseUrl: 'https://apex.example',
      getToken: jest.fn().mockResolvedValue('token'),
      fetchImpl: fetchImpl as never,
    });

    await expect(client.postIngest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-stale',
      kind: 'heartbeat',
    })).rejects.toBeInstanceOf(AiRunFenceConflictError);
  });

  it('TBI-004 callback contract: preserves non-fence callback failures as ordinary errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(409, {
      code: 'AI_RUN_ILLEGAL_TRANSITION',
      error: 'illegal transition',
    }));
    const client = createAiRunsCallbackClient({
      callbackBaseUrl: 'https://apex.example',
      getToken: jest.fn().mockResolvedValue('token'),
      fetchImpl: fetchImpl as never,
    });

    await expect(client.postIngest('project-1', 'run-1', {
      dispatchMessageId: 'dispatch-current',
      kind: 'heartbeat',
    })).rejects.toBeInstanceOf(AiRunCallbackError);
  });
});
