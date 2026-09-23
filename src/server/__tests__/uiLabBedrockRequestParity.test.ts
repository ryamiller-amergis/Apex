const requests: Array<Record<string, unknown>> = [];
let timeoutMode = false;

const MODEL_HTML =
  '<!DOCTYPE html><html><body><!-- STATE:DEFAULT:START -->ok<!-- STATE:DEFAULT:END --></body></html>';

jest.mock('@aws-sdk/client-bedrock-runtime', () => {
  const actual = jest.requireActual('@aws-sdk/client-bedrock-runtime');
  return {
    ...actual,
    BedrockRuntimeClient: class {
      async send(
        command: { input: Record<string, unknown> },
        options?: { abortSignal?: AbortSignal },
      ): Promise<unknown> {
        requests.push(command.input);
        if (timeoutMode) {
          return new Promise<never>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              'abort',
              () => reject(new Error('socket aborted')),
              { once: true },
            );
          });
        }
        if (command.constructor.name.includes('WithResponseStream')) {
          async function* body() {
            yield {
              chunk: {
                bytes: new TextEncoder().encode(
                  JSON.stringify({
                    type: 'message_start',
                    message: { usage: { input_tokens: 12 } },
                  }),
                ),
              },
            };
            yield {
              chunk: {
                bytes: new TextEncoder().encode(
                  JSON.stringify({
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: MODEL_HTML },
                  }),
                ),
              },
            };
            yield {
              chunk: {
                bytes: new TextEncoder().encode(
                  JSON.stringify({
                    type: 'message_delta',
                    usage: { output_tokens: 34 },
                  }),
                ),
              },
            };
          }
          return { body: body() };
        }
        return {
          body: new TextEncoder().encode(
            JSON.stringify({
              content: [{ type: 'text', text: MODEL_HTML }],
              usage: { input_tokens: 12, output_tokens: 34 },
            }),
          ),
        };
      }
    },
  };
});

jest.mock('../services/foundationSkillResolverService', () => ({
  resolveLocalSkillBundle: jest.fn(() => ({
    content: '# UI Lab\n\nUse 8px spacing.',
    notFound: false,
  })),
  resolveRemoteSkillBundle: jest.fn(),
  logBundleDiagnostics: jest.fn(),
}));

jest.mock('../services/designSystemService', () => ({
  getDesignSystemCatalog: jest.fn(async () => ({
    routes: [{ path: '/timecards', title: 'Timecards' }],
    tokensCss: ':root { --primary: #323695; }',
    componentNames: ['DataGrid'],
    componentDescriptions: { DataGrid: 'Sortable table' },
    uiKnowledgeBase: 'Timecards lists one week of entries per worker.',
  })),
  getScreenInventory: jest.fn(async () => [
    {
      route: '/timecards',
      purpose: 'Approve submitted hours',
      userTypes: ['Supervisor'],
    },
  ]),
  fetchExistingPageContext: jest.fn(
    async () => 'export const Timecards = () => <main />;',
  ),
}));

jest.mock('../services/designTokensService', () => ({
  getMaxviewColorTokens: jest.fn(() => 'primary.main: #323695'),
  getApexColorTokens: jest.fn(() => '--apex-primary: #323695'),
}));

jest.mock('../services/figmaReferenceService', () => ({
  getFigmaReference: jest.fn(() => ({
    navItems: [{ label: 'Home', route: '/home' }],
    tablePageBase64: 'QUJD',
    tablePageWidth: 1024,
    tablePageHeight: 810,
  })),
}));

jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn(),
  computeCost: jest.fn(async () => 0),
}));

import { buildUiLabVisualSpecification } from '../services/aiRunV2/visualSpecificationBuilder';
import {
  generateUiLabDesign,
  resolveUiLabVisualModel,
} from '../services/uiLabBedrockService';
import { createBedrockVisualClient } from '../services/aiRunsV2Worker/bedrockVisualClient';
import { createVisualExecute } from '../services/aiRunsV2Worker/visualEntrypoint';

function checkpoints() {
  return {
    publishStarted: async () => undefined,
    publishHeartbeat: async () => undefined,
    publishProgress: async () => undefined,
    lastSequence: () => 0,
  };
}

describe('UI Lab Bedrock request parity', () => {
  beforeEach(() => {
    requests.length = 0;
    timeoutMode = false;
  });

  it('sends the same request through in-process and V2 generation', async () => {
    const model = resolveUiLabVisualModel({
      modelId: 'anthropic.claude',
      maxTokens: 16_000,
      timeoutMs: 600_000,
      temperature: 0.2,
    });

    const v1Tokens: string[] = [];
    const v1Html = await generateUiLabDesign({
      prompt: 'Build a timecard approval queue',
      targetRoute: '/timecards',
      project: 'MaxView',
      modelId: model.modelId,
      maxTokens: model.maxTokens,
      timeoutMs: model.timeoutMs,
      temperature: model.temperature,
      onToken: (text) => v1Tokens.push(text),
    });

    const specification = buildUiLabVisualSpecification({
      designId: 'design-1',
      userPrompt: 'Build a timecard approval queue',
      targetRoute: '/timecards',
      designSystemName: 'MaxView',
      skillMarkdown: '# UI Lab\n\nUse 8px spacing.',
      componentIndex: '',
      existingPageContext: 'export const Timecards = () => <main />;',
      colorTokens: 'primary.main: #323695',
      catalog: {
        routes: [{ path: '/timecards', title: 'Timecards' }],
        tokensCss: ':root { --primary: #323695; }',
        componentNames: ['DataGrid'],
        componentDescriptions: { DataGrid: 'Sortable table' },
        uiKnowledgeBase: 'Timecards lists one week of entries per worker.',
      },
      screenInventory: [
        {
          route: '/timecards',
          purpose: 'Approve submitted hours',
          userTypes: ['Supervisor'],
        },
      ],
      navItems: [{ label: 'Home', route: '/home' }],
      images: [
        {
          kind: 'design-reference',
          base64: 'QUJD',
          mediaType: 'image/png',
          width: 1024,
          height: 810,
        },
      ],
      model,
      usage: { feature: 'ui-lab', project: 'MaxView' },
    });
    const workerTokens: string[] = [];
    const execute = createVisualExecute({
      invokeModel: jest.fn(),
      invokeStreamingModel: (prompt, settings, images, onText, signal) =>
        createBedrockVisualClient().invokeStreamingModel(
          prompt,
          settings,
          images,
          onText,
          signal,
        ),
      createProgressBatcher: ({ publish }) => {
        let text = '';
        return {
          push: (delta: string) => {
            text += delta;
          },
          close: async () => {
            workerTokens.push(text);
            await publish(text, 0);
          },
        };
      },
    });

    const outcome = await execute({
      specification,
      command: {} as never,
      checkpoints: checkpoints(),
      signal: new AbortController().signal,
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(workerTokens).toEqual(v1Tokens);
    expect(outcome.files[0].content).toBe(v1Html);
  });

  it('surfaces the same timeout error through both streaming paths', async () => {
    jest.useFakeTimers();
    timeoutMode = true;
    try {
      const model = resolveUiLabVisualModel({
        modelId: 'anthropic.claude',
        maxTokens: 16_000,
        timeoutMs: 10,
        temperature: 0.2,
      });
      const inProcess = generateUiLabDesign({
        prompt: 'Build a queue',
        project: 'MaxView',
        modelId: model.modelId,
        maxTokens: model.maxTokens,
        timeoutMs: model.timeoutMs,
        temperature: model.temperature,
        onToken: jest.fn(),
      }).catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(10);
      const inProcessError = await inProcess;

      const worker = createBedrockVisualClient()
        .invokeStreamingModel(
          'prompt',
          model,
          [],
          jest.fn(),
        )
        .catch((error: Error) => error);
      await jest.advanceTimersByTimeAsync(10);
      const workerError = await worker;

      expect(inProcessError).toBeInstanceOf(Error);
      expect(workerError).toBeInstanceOf(Error);
      if (!(inProcessError instanceof Error) || !(workerError instanceof Error)) {
        throw new Error('Expected both streaming paths to reject');
      }
      expect(workerError.message).toBe(inProcessError.message);
    } finally {
      jest.useRealTimers();
    }
  });
});
