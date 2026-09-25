import type { InteractiveDispatchOutboxPayload } from '../../../shared/types/durableInteractiveTurn';
import { createInteractiveActorDispatchClient } from '../../services/aiOrchestrator/interactiveActorDispatchClient';

const BASE_PAYLOAD: InteractiveDispatchOutboxPayload = {
  schemaVersion: 2,
  kind: 'interactive_dispatch',
  transport: 'dapr-actor-v2',
  runId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  attemptNumber: 1,
  dispatchMessageId: '33333333-3333-4333-8333-333333333333',
  threadId: '44444444-4444-4444-8444-444444444444',
  userId: 'user-1',
  interactiveClass: 'fast',
  workloadLane: 'fast',
  capacityClass: 'interactive',
  deadlineAt: '2026-09-23T15:05:00.000Z',
};

function payload(
  overrides: Partial<InteractiveDispatchOutboxPayload> = {},
): InteractiveDispatchOutboxPayload {
  const interactiveClass =
    overrides.interactiveClass ?? BASE_PAYLOAD.interactiveClass;
  return {
    ...BASE_PAYLOAD,
    ...overrides,
    interactiveClass,
    workloadLane: interactiveClass,
  };
}

function response(
  body: unknown,
  options: Readonly<{ ok?: boolean; status?: number }> = {},
): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 202,
    json: async () => body,
  } as Response;
}

describe('interactiveActorDispatchClient', () => {
  it('calls only the endpoint matching the persisted class', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ accepted: true }));
    const client = createInteractiveActorDispatchClient({
      fastUrl: 'https://fast.example/',
      agenticUrl: ' https://agentic.example/// ',
      fetchImpl,
    });

    const request = payload({ interactiveClass: 'agentic' });
    const controller = new AbortController();
    await client.dispatch(request, {
      signal: controller.signal,
      deadlineAt: request.deadlineAt,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://agentic.example/dispatch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
        signal: controller.signal,
        headers: expect.objectContaining({
          'x-apex-dispatch-deadline': request.deadlineAt,
        }),
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'https://fast.example/dispatch',
      expect.anything(),
    );
  });

  it('never falls back to the other class endpoint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ accepted: true }));
    const client = createInteractiveActorDispatchClient({
      fastUrl: 'https://fast.example',
      agenticUrl: ' ',
      fetchImpl,
    });

    await expect(
      client.dispatch(payload({ interactiveClass: 'agentic' }), {
        signal: new AbortController().signal,
        deadlineAt: BASE_PAYLOAD.deadlineAt,
      }),
    ).rejects.toThrow(
      'Interactive agentic dispatch endpoint is not configured',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a successful accepted response', async () => {
    const rejectedFetch = jest
      .fn()
      .mockResolvedValue(response({ accepted: true }, { ok: false, status: 503 }));
    const rejectedClient = createInteractiveActorDispatchClient({
      fastUrl: 'https://fast.example',
      agenticUrl: 'https://agentic.example',
      fetchImpl: rejectedFetch,
    });

    await expect(
      rejectedClient.dispatch(payload(), {
        signal: new AbortController().signal,
        deadlineAt: BASE_PAYLOAD.deadlineAt,
      }),
    ).rejects.toThrow('Interactive fast dispatch failed with status 503');

    const unacceptedFetch = jest
      .fn()
      .mockResolvedValue(response({ accepted: false }));
    const unacceptedClient = createInteractiveActorDispatchClient({
      fastUrl: 'https://fast.example',
      agenticUrl: 'https://agentic.example',
      fetchImpl: unacceptedFetch,
    });

    await expect(
      unacceptedClient.dispatch(payload(), {
        signal: new AbortController().signal,
        deadlineAt: BASE_PAYLOAD.deadlineAt,
      }),
    ).rejects.toThrow('Interactive fast dispatch was not accepted');
  });

  it('passes abort through to a hanging fetch', async () => {
    const fetchImpl = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = createInteractiveActorDispatchClient({
      fastUrl: 'https://fast.example',
      agenticUrl: 'https://agentic.example',
      fetchImpl,
    });
    const controller = new AbortController();
    const pending = client.dispatch(payload(), {
      signal: controller.signal,
      deadlineAt: BASE_PAYLOAD.deadlineAt,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
