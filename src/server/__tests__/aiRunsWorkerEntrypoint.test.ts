import {
  loadAiRunsDispatchMessage,
  receiveAiRunsDispatchFromServiceBus,
} from '../services/aiRunsWorker/entrypoint';

describe('aiRunsWorker dispatch receive', () => {
  it('TBI-004 payload-minimal contract: reads local dispatch with only run and fence IDs', async () => {
    const previous = process.env.AI_RUNS_DISPATCH_MESSAGE_JSON;
    process.env.AI_RUNS_DISPATCH_MESSAGE_JSON = JSON.stringify({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
    try {
      await expect(loadAiRunsDispatchMessage()).resolves.toEqual({
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      });
    } finally {
      if (previous === undefined) delete process.env.AI_RUNS_DISPATCH_MESSAGE_JSON;
      else process.env.AI_RUNS_DISPATCH_MESSAGE_JSON = previous;
    }
  });

  it('TBI-004 payload-minimal contract: rejects local dispatch carrying snapshot content', async () => {
    const previous = process.env.AI_RUNS_DISPATCH_MESSAGE_JSON;
    process.env.AI_RUNS_DISPATCH_MESSAGE_JSON = JSON.stringify({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
      prompt: 'must not be on Service Bus',
    });
    try {
      await expect(loadAiRunsDispatchMessage()).rejects.toThrow(
        'only runId and dispatchMessageId',
      );
    } finally {
      if (previous === undefined) delete process.env.AI_RUNS_DISPATCH_MESSAGE_JSON;
      else process.env.AI_RUNS_DISPATCH_MESSAGE_JSON = previous;
    }
  });

  it('TBI-004 Service Bus contract: receives one queue message with managed-identity bearer auth', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      }),
    });

    await expect(receiveAiRunsDispatchFromServiceBus({
      namespace: 'sbns-apex-ai-dev',
      queueName: 'ai-runs-background',
      getAccessToken: jest.fn().mockResolvedValue('service-bus-token'),
      fetchImpl: fetchImpl as never,
    })).resolves.toEqual({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://sbns-apex-ai-dev.servicebus.windows.net/ai-runs-background/messages/head?timeout=60',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          Authorization: 'Bearer service-bus-token',
        }),
      }),
    );
  });
});
