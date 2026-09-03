import { HttpMethod, type DaprInvokerCallbackContent } from '@dapr/dapr';
import {
  parseInteractiveDispatchRequest,
  registerInteractiveDispatchHandler,
} from '../services/interactiveActorHost/entrypoint';

describe('interactive actor host dispatch endpoint', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses the Dapr-wrapped JSON request body', () => {
    expect(
      parseInteractiveDispatchRequest({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).toEqual({
      threadId: 'thread-1',
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  it('rejects invalid JSON and incomplete dispatch identifiers', () => {
    expect(() => parseInteractiveDispatchRequest({ body: '{' })).toThrow(
      'Interactive dispatch body must be valid JSON'
    );
    expect(() =>
      parseInteractiveDispatchRequest({
        body: JSON.stringify({ threadId: 'thread-1', runId: 'run-1' }),
      })
    ).toThrow(
      'Interactive dispatch requires threadId, runId, and dispatchMessageId'
    );
  });

  it('registers POST /dispatch and invokes the thread actor', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>,
        options: { method: HttpMethod }
      ) => {
        callback = handler;
        expect(methodName).toBe('dispatch');
        expect(options).toEqual({ method: HttpMethod.POST });
      }
    );
    const handleTurn = jest.fn().mockResolvedValue({
      status: 'completed',
      cursorAgentId: 'agent-1',
    });
    const resolveActor = jest.fn(() => ({ handleTurn }));
    jest.spyOn(console, 'log').mockImplementation(() => {});

    await registerInteractiveDispatchHandler({ listen }, resolveActor);
    expect(callback).toBeDefined();

    const result = await callback!({
      body: JSON.stringify({
        threadId: 'thread-1',
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      }),
    });

    expect(result).toEqual({ accepted: true });
    expect(resolveActor).toHaveBeenCalledWith('thread-1');
    expect(handleTurn).toHaveBeenCalledWith({
      runId: 'run-1',
      dispatchMessageId: 'dispatch-1',
    });
  });

  it('rejects an invalid dispatch without crashing the host', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    const resolveActor = jest.fn();
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    await registerInteractiveDispatchHandler({ listen }, resolveActor);

    await expect(callback!({ body: '{}' })).resolves.toEqual({
      accepted: false,
    });
    expect(resolveActor).not.toHaveBeenCalled();
  });

  it('acknowledges dispatch and durably recovers an actor invocation failure', async () => {
    let callback:
      | ((content: DaprInvokerCallbackContent) => Promise<unknown>)
      | undefined;
    const listen = jest.fn(
      async (
        _methodName: string,
        handler: (content: DaprInvokerCallbackContent) => Promise<unknown>
      ) => {
        callback = handler;
      }
    );
    const handleTurn = jest
      .fn()
      .mockRejectedValue(new Error('actor unavailable'));
    const recoverActorFailure = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await registerInteractiveDispatchHandler(
      { listen },
      () => ({ handleTurn }),
      recoverActorFailure
    );

    await expect(
      callback!({
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          dispatchMessageId: 'dispatch-1',
        }),
      })
    ).resolves.toEqual({ accepted: true });
    await Promise.resolve();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"InteractiveDispatchFailed"')
    );
    expect(recoverActorFailure).toHaveBeenCalledWith(
      {
        threadId: 'thread-1',
        runId: 'run-1',
        dispatchMessageId: 'dispatch-1',
      },
      expect.objectContaining({ message: 'actor unavailable' })
    );
  });
});
