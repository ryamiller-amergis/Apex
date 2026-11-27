let mockContent: unknown[];

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: class {
      async send(): Promise<unknown> {
        return {
          body: new TextEncoder().encode(
            JSON.stringify({
              content: mockContent,
              stop_reason: 'end_turn',
              usage: { input_tokens: 10, output_tokens: 20 },
            }),
          ),
        };
      }
    },
  };
});

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn().mockResolvedValue(undefined),
  computeCost: jest.fn().mockResolvedValue(0),
}));

import { invokeBedrockText } from '../services/bedrockService';

const usage = { feature: 'other' as const, project: 'Apex' };

describe('invokeBedrockText reply text', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the answer when a thinking block comes first', async () => {
    mockContent = [
      { type: 'thinking', thinking: 'Plan the skill.', signature: 'sig' },
      { type: 'text', text: '<description>d</description>' },
    ];
    await expect(invokeBedrockText('prompt', usage)).resolves.toBe('<description>d</description>');
  });

  it('joins every text block in order', async () => {
    mockContent = [
      { type: 'text', text: 'first ' },
      { type: 'text', text: 'second' },
    ];
    await expect(invokeBedrockText('prompt', usage)).resolves.toBe('first second');
  });

  it('logs the block types when the reply has no text', async () => {
    mockContent = [{ type: 'thinking', thinking: 'Only thoughts.', signature: 'sig' }];
    await expect(invokeBedrockText('prompt', usage)).resolves.toBe('');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('blocks=thinking'));
  });
});
