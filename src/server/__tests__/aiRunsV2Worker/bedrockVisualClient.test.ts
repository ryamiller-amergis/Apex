import {
  createBedrockVisualClient,
  VisualModelTruncatedError,
} from '../../services/aiRunsV2Worker/bedrockVisualClient';

function response(body: unknown) {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function streamingResponse(events: unknown[]) {
  return {
    body: (async function* stream() {
      for (const event of events) {
        yield {
          chunk: {
            bytes: new TextEncoder().encode(JSON.stringify(event)),
          },
        };
      }
    })(),
  };
}

/**
 * Every value the client sends arrives on the specification, so the fixture
 * carries a complete one. There is nothing left for the client to default.
 */
const MODEL = {
  modelId: 'anthropic.claude',
  region: 'us-east-1',
  maxTokens: 8_000,
  timeoutMs: 600_000,
  retry: {
    maxAttempts: 5,
    initialBackoffMs: 2_000,
    backoffMultiplier: 2,
    jitter: true,
  },
};

describe('bedrockVisualClient', () => {
  it('streams text deltas and returns the full HTML with reported usage', async () => {
    const send = jest.fn().mockResolvedValue(
      streamingResponse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 120,
              cache_read_input_tokens: 8,
              cache_creation_input_tokens: 3,
            },
          },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: '<html>' },
        },
        {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'ok</html>' },
        },
        {
          type: 'message_delta',
          usage: { output_tokens: 3400 },
        },
      ]),
    );
    const onText = jest.fn();
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeStreamingModel(
      'a prompt',
      { ...MODEL, temperature: 0.2 },
      [],
      onText,
    );

    expect(onText.mock.calls.map(([text]) => text)).toEqual([
      '<html>',
      'ok</html>',
    ]);
    expect(result).toMatchObject({
      html: '<html>ok</html>',
      usage: {
        inputTokens: 120,
        outputTokens: 3400,
        cacheReadTokens: 8,
        cacheWriteTokens: 3,
      },
    });
    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content).toEqual([
      { type: 'text', text: 'a prompt' },
    ]);
    expect(payload.temperature).toBe(0.2);
  });

  it('returns the model text and the tokens it reported', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html>ok</html>' }],
        usage: { input_tokens: 120, output_tokens: 3400 },
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', MODEL);

    expect(result.html).toBe('<html>ok</html>');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 3400 });
  });

  it('sends the specification model id and token ceiling', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel('a prompt', {
      ...MODEL,
      modelId: 'anthropic.claude-sonnet',
      maxTokens: 12000,
    });

    const command = send.mock.calls[0][0];
    expect(command.input.modelId).toBe('anthropic.claude-sonnet');
    const payload = JSON.parse(command.input.body as string);
    expect(payload.max_tokens).toBe(12000);
    expect(payload.anthropic_version).toBe('bedrock-2023-05-31');
    expect(payload.messages[0].content).toBe('a prompt');
  });

  /**
   * The in-process path sends the Figma screenshot as a vision input and the
   * prompt tells the model to read it. Order matters: `bedrockService` puts
   * the image ahead of the text, and that ordering is part of what produces
   * today's output.
   */
  it('puts the reference screenshot ahead of the prompt text, as bedrockService does', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel(
      'a prompt',
      MODEL,
      [{ base64: 'QUJD', mediaType: 'image/png' }],
    );

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
      },
      { type: 'text', text: 'a prompt' },
    ]);
  });

  it('sends the media type it was given rather than assuming png', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel(
      'a prompt',
      MODEL,
      [{ base64: 'QUJD', mediaType: 'image/jpeg' }],
    );

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content[0].source.media_type).toBe('image/jpeg');
  });

  it('preserves every image block in specification order before the prompt', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel(
      'an EXTEND prompt',
      MODEL,
      [
        { base64: 'QUJD', mediaType: 'image/png' },
        { base64: 'REVG', mediaType: 'image/jpeg' },
      ],
    );

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'QUJD' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'REVG' },
      },
      { type: 'text', text: 'an EXTEND prompt' },
    ]);
  });

  /**
   * A reference is optional — `getFigmaReference` can return none. With no
   * image the call must look exactly as it did before images existed.
   */
  it('sends plain string content when there is no reference image', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel('a prompt', MODEL);

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content).toBe('a prompt');
  });

  it('sends plain string content when the reference carries no base64', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel(
      'a prompt',
      MODEL,
      [{ base64: '', mediaType: 'image/png' }],
    );

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content).toBe('a prompt');
  });

  it('reports zero tokens when the model omits usage rather than guessing', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', MODEL);

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('surfaces an empty completion instead of returning undefined text', async () => {
    const send = jest.fn().mockResolvedValue(response({ content: [] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', MODEL);

    expect(result.html).toBe('');
  });

  /**
   * UI Lab reads `ui_lab_bedrock_temperature` from project settings and sets
   * it in process. The key is absent from the payload when the project set
   * none, because an invented default is a policy the worker does not hold.
   */
  it('sends the temperature when the specification carries one', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel('a prompt', { ...MODEL, temperature: 0.2 });

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.temperature).toBe(0.2);
  });

  it('omits temperature entirely when the specification carries none', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel('a prompt', MODEL);

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(Object.keys(payload)).not.toContain('temperature');
  });

  it('retries throttles with the resolved attempt count and exponential backoff', async () => {
    const throttle = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    const send = jest
      .fn()
      .mockRejectedValueOnce(throttle)
      .mockRejectedValueOnce(throttle)
      .mockResolvedValue(
        response({ content: [{ type: 'text', text: '<html>done</html>' }] }),
      );
    const sleep = jest.fn().mockResolvedValue(undefined);
    const client = createBedrockVisualClient({
      client: { send } as never,
      sleep,
    } as never);

    await expect(
      client.invokeModel('a prompt', {
        ...MODEL,
        retry: { ...MODEL.retry, maxAttempts: 3, jitter: false },
      }),
    ).resolves.toMatchObject({ html: '<html>done</html>' });

    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([2_000, 4_000]);
  });

  it.each([
    { statusCode: 429 },
    { statusCode: 503 },
    { $metadata: { httpStatusCode: 500 } },
  ])('retries transient Bedrock failure %#', async (fields) => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('transient'), fields))
      .mockResolvedValue(
        response({ content: [{ type: 'text', text: '<html>done</html>' }] }),
      );
    const sleep = jest.fn().mockResolvedValue(undefined);
    const client = createBedrockVisualClient({
      client: { send } as never,
      sleep,
    } as never);

    await client.invokeModel('a prompt', {
      ...MODEL,
      retry: { ...MODEL.retry, maxAttempts: 2, jitter: false },
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-transient model failure', async () => {
    const send = jest.fn().mockRejectedValue(new Error('bad request'));
    const sleep = jest.fn().mockResolvedValue(undefined);
    const client = createBedrockVisualClient({
      client: { send } as never,
      sleep,
    } as never);

    await expect(client.invokeModel('a prompt', MODEL)).rejects.toThrow(
      'bad request',
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops at maxAttempts without sleeping after the final failure', async () => {
    const throttle = Object.assign(new Error('still throttled'), {
      name: 'TooManyRequestsException',
    });
    const send = jest.fn().mockRejectedValue(throttle);
    const sleep = jest.fn().mockResolvedValue(undefined);
    const client = createBedrockVisualClient({
      client: { send } as never,
      sleep,
    } as never);

    await expect(
      client.invokeModel('a prompt', {
        ...MODEL,
        retry: { ...MODEL.retry, maxAttempts: 3, jitter: false },
      }),
    ).rejects.toThrow('still throttled');
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('aborts during backoff without starting another model call', async () => {
    const throttle = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    const send = jest.fn().mockRejectedValue(throttle);
    const controller = new AbortController();
    const deadline = new Error('Execution deadline elapsed');
    deadline.name = 'AbortError';
    const sleep = jest.fn(async (_delay: number, signal?: AbortSignal) => {
      controller.abort(deadline);
      if (signal?.aborted) throw signal.reason;
    });
    const client = createBedrockVisualClient({
      client: { send } as never,
      sleep,
    } as never);

    await expect(
      (client.invokeModel as unknown as (
        prompt: string,
        model: typeof MODEL,
        images: [],
        signal: AbortSignal,
      ) => Promise<unknown>)('a prompt', MODEL, [], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not retry an attempt that reached its per-call timeout', async () => {
    jest.useFakeTimers();
    try {
      const send = jest.fn(
        async (
          _command: unknown,
          options?: { abortSignal?: AbortSignal },
        ): Promise<never> =>
          new Promise<never>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
          }),
      );
      const sleep = jest.fn().mockResolvedValue(undefined);
      const client = createBedrockVisualClient({
        client: { send } as never,
        sleep,
      });
      const result = client.invokeModel('a prompt', {
        ...MODEL,
        timeoutMs: 10,
        retry: { ...MODEL.retry, maxAttempts: 3, jitter: false },
      });
      const refusal = expect(result).rejects.toThrow(
        'Bedrock request timed out after 0s',
      );

      await jest.advanceTimersByTimeAsync(10);

      await refusal;
      expect(send).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the V2 streaming deadline active through body iteration', async () => {
    jest.useFakeTimers();
    try {
      let releaseBody!: () => void;
      let nextCall = 0;
      const body = {
        [Symbol.asyncIterator]() {
          return {
            next: () => {
              nextCall += 1;
              if (nextCall === 1) {
                return Promise.resolve({
                  done: false,
                  value: {
                    chunk: {
                      bytes: new TextEncoder().encode(
                        JSON.stringify({
                          type: 'message_start',
                          message: { usage: { input_tokens: 1 } },
                        }),
                      ),
                    },
                  },
                });
              }
              return new Promise<IteratorResult<unknown>>((resolve) => {
                releaseBody = () => resolve({ done: true, value: undefined });
              });
            },
          };
        },
      };
      const send = jest.fn().mockResolvedValue({ body });
      const client = createBedrockVisualClient({
        client: { send } as never,
      });
      const result = client.invokeStreamingModel(
        'a prompt',
        { ...MODEL, timeoutMs: 10 },
        [],
        jest.fn(),
        undefined,
        { absoluteTimeout: true },
      );
      const refusal = expect(result).rejects.toThrow(
        'Bedrock request timed out after 0s',
      );

      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(10);
      releaseBody?.();

      await refusal;
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * `stop_reason: 'max_tokens'` means the model was still writing when it ran
   * out of room, so the text is a fragment. `bedrockService.invokeModel`
   * throws on it; this client returned the fragment, which the worker uploaded
   * and the run finalized as a completed prototype.
   */
  it('refuses a response the model was cut off from finishing', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html><body><table' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 120, output_tokens: 8000 },
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    await expect(client.invokeModel('a prompt', MODEL)).rejects.toBeInstanceOf(
      VisualModelTruncatedError,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  /**
   * The message is what reaches the prototype row, so it is
   * `BedrockModelTruncatedError`'s word for word — a truncated prototype must
   * read the same whichever transport ran it.
   */
  it('says what was hit and what to do about it, in the in-process wording', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html><body><table' }],
        stop_reason: 'max_tokens',
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    await expect(client.invokeModel('a prompt', MODEL)).rejects.toThrow(
      'Model response was truncated at 8000 output tokens. '
        + 'Increase BEDROCK_UI_MOCK_MAX_TOKENS or use a more concise prompt.',
    );
  });

  it('reports the ceiling it was given rather than a constant of its own', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html' }],
        stop_reason: 'max_tokens',
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    await expect(
      client.invokeModel('a prompt', { ...MODEL, maxTokens: 32_000 }),
    ).rejects.toThrow('truncated at 32000 output tokens');
  });

  /** The fragment stays on the error for a log, and off the return value. */
  it('keeps the partial text on the error instead of returning it', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html><body><table' }],
        stop_reason: 'max_tokens',
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    await expect(client.invokeModel('a prompt', MODEL)).rejects.toMatchObject({
      name: 'VisualModelTruncatedError',
      modelText: '<html><body><table',
      maxTokens: 8_000,
    });
  });

  it('returns the completion when the model stopped on its own', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html>done</html>' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 3400 },
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', MODEL);

    expect(result.html).toBe('<html>done</html>');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 3400 });
  });

  /**
   * Only `max_tokens` means a cut-off document. Refusing any other stop reason
   * would fail runs the in-process path completes.
   */
  it.each(['stop_sequence', 'tool_use', 'refusal'])(
    'returns the completion for stop_reason %s, as the in-process path does',
    async (stopReason) => {
      const send = jest.fn().mockResolvedValue(
        response({
          content: [{ type: 'text', text: '<html>done</html>' }],
          stop_reason: stopReason,
        }),
      );
      const client = createBedrockVisualClient({ client: { send } as never });

      await expect(client.invokeModel('a prompt', MODEL)).resolves.toMatchObject({
        html: '<html>done</html>',
      });
    },
  );

  it('returns the completion when the model reports no stop reason at all', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html>done</html>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await expect(client.invokeModel('a prompt', MODEL)).resolves.toMatchObject({
      html: '<html>done</html>',
    });
  });
});
