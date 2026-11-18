import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { createBedrockPromptfooGrader, toAnthropicMessages } from '../../services/aiRunsV2Worker/promptfooBedrockGrader';

const grader = { provider: 'bedrock' as const, modelId: 'us.anthropic.test', region: 'us-east-2', maxTokens: 512, timeoutMs: 30_000 };

function reply(text: string) {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text }] })) };
}

describe('promptfooBedrockGrader', () => {
  it('splits a Promptfoo chat prompt into a system prompt and turns', () => {
    const prompt = JSON.stringify([
      { role: 'system', content: 'You grade.' },
      { role: 'user', content: '<Output>x</Output>' },
    ]);
    expect(toAnthropicMessages(prompt)).toEqual({ system: 'You grade.', messages: [{ role: 'user', content: '<Output>x</Output>' }] });
  });

  it('sends anything else as one user message', () => {
    expect(toAnthropicMessages('Is this good?')).toEqual({ messages: [{ role: 'user', content: 'Is this good?' }] });
    expect(toAnthropicMessages('{"a":1}')).toEqual({ messages: [{ role: 'user', content: '{"a":1}' }] });
  });

  it('calls the model the specification names and returns its text', async () => {
    const send = jest.fn().mockResolvedValue(reply('{"pass":true,"reason":"ok"}'));
    const grade = createBedrockPromptfooGrader({ client: { send } as never });
    await expect(grade('Is this good?', grader, new AbortController().signal)).resolves.toBe('{"pass":true,"reason":"ok"}');

    const command = send.mock.calls[0][0] as InvokeModelCommand;
    expect(command.input.modelId).toBe('us.anthropic.test');
    expect(JSON.parse(command.input.body as string)).toMatchObject({ max_tokens: 512, messages: [{ role: 'user', content: 'Is this good?' }] });
  });

  it('reports a grading call that ran past its timeout', async () => {
    const send = jest.fn((_command: unknown, options: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
      options.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const grade = createBedrockPromptfooGrader({ client: { send } as never });
    await expect(grade('x', { ...grader, timeoutMs: 20 }, new AbortController().signal)).rejects.toThrow('Grading timed out');
  });
});
