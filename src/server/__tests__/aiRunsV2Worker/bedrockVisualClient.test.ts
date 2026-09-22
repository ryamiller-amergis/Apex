import { createBedrockVisualClient } from '../../services/aiRunsV2Worker/bedrockVisualClient';

function response(body: unknown) {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/**
 * Every value the client sends arrives on the specification, so the fixture
 * carries a complete one. There is nothing left for the client to default.
 */
const MODEL = {
  modelId: 'anthropic.claude',
  maxTokens: 8_000,
  timeoutMs: 600_000,
};

describe('bedrockVisualClient', () => {
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
      { base64: 'QUJD', mediaType: 'image/png' },
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
      { base64: 'QUJD', mediaType: 'image/jpeg' },
    );

    const payload = JSON.parse(send.mock.calls[0][0].input.body as string);
    expect(payload.messages[0].content[0].source.media_type).toBe('image/jpeg');
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
      { base64: '', mediaType: 'image/png' },
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
});
