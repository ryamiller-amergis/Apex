import { createBedrockVisualClient } from '../../services/aiRunsV2Worker/bedrockVisualClient';

function response(body: unknown) {
  return {
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

describe('bedrockVisualClient', () => {
  it('returns the model text and the tokens it reported', async () => {
    const send = jest.fn().mockResolvedValue(
      response({
        content: [{ type: 'text', text: '<html>ok</html>' }],
        usage: { input_tokens: 120, output_tokens: 3400 },
      }),
    );
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', {
      modelId: 'anthropic.claude',
      maxTokens: 8000,
    });

    expect(result.html).toBe('<html>ok</html>');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 3400 });
  });

  it('sends the specification model id and token ceiling', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    await client.invokeModel('a prompt', {
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

  it('reports zero tokens when the model omits usage rather than guessing', async () => {
    const send = jest
      .fn()
      .mockResolvedValue(response({ content: [{ type: 'text', text: '<html/>' }] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', {
      modelId: 'anthropic.claude',
    });

    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('surfaces an empty completion instead of returning undefined text', async () => {
    const send = jest.fn().mockResolvedValue(response({ content: [] }));
    const client = createBedrockVisualClient({ client: { send } as never });

    const result = await client.invokeModel('a prompt', {
      modelId: 'anthropic.claude',
    });

    expect(result.html).toBe('');
  });
});
