import { DiagramAiGenerationError, DiagramValidationError } from '../../shared/types/diagram';
import {
  APEX_AI_MERMAID_APP_STATE_KEY,
  graphToMermaid,
} from '../../shared/utils/graphToMermaid';
import { invokeBedrockText } from '../services/bedrockService';
import { generateDiagramFromPrompt } from '../services/diagramAiService';

jest.mock('../services/bedrockService', () => ({
  invokeBedrockText: jest.fn(),
}));

const mockedInvokeBedrockText = invokeBedrockText as jest.MockedFunction<typeof invokeBedrockText>;

describe('diagramAiService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('V1-1/V1-4 turns a bounded Bedrock graph into Mermaid for client materialization', async () => {
    mockedInvokeBedrockText.mockResolvedValue(JSON.stringify({
      title: 'Order processing',
      nodes: [
        { id: 'request', label: 'Receive order' },
        { id: 'validate', label: 'Validate payment' },
        { id: 'ship', label: 'Ship order' },
      ],
      edges: [
        { from: 'request', to: 'validate', label: 'next' },
        { from: 'validate', to: 'ship' },
      ],
    }));

    const result = await generateDiagramFromPrompt(
      'project-a',
      'Show how an order moves from intake to shipping',
      'user-1',
    );

    expect(result.title).toBe('Order processing');
    expect(result.scene.elements).toEqual([]);
    const mermaid = result.scene.appState[APEX_AI_MERMAID_APP_STATE_KEY];
    expect(typeof mermaid).toBe('string');
    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).toContain('Receive order');
    expect(mermaid).toContain('request --> validate');
    expect(graphToMermaid({
      nodes: [
        { id: 'request', label: 'Receive order' },
        { id: 'validate', label: 'Validate payment' },
      ],
      edges: [{ from: 'request', to: 'validate' }],
    })).toContain('request --> validate');
    expect(mockedInvokeBedrockText).toHaveBeenCalledWith(
      expect.stringContaining('Show how an order moves from intake to shipping'),
      {
        feature: 'other',
        project: 'project-a',
        entityType: 'diagram-generation',
        userId: 'user-1',
      },
      { maxTokens: 4096 },
    );
  });

  it('renames reserved node ids and escapes labels so Mermaid can parse the flowchart', () => {
    const mermaid = graphToMermaid({
      nodes: [
        { id: 'end', label: 'Auth [JWT]' },
        { id: 'cache', label: 'Cache [Redis]' },
      ],
      edges: [{ from: 'end', to: 'cache' }],
    });

    expect(mermaid).toContain('flowchart TD');
    expect(mermaid).not.toMatch(/(?:^|\s)end\[/);
    expect(mermaid).toContain('n_end["Auth [JWT#93;"]');
    expect(mermaid).toContain('cache["Cache [Redis#93;"]');
    expect(mermaid).toContain('n_end --> cache');
  });

  it('V1-4 rejects an empty prompt before invoking Bedrock', async () => {
    await expect(generateDiagramFromPrompt('project-a', '   ', 'user-1'))
      .rejects.toBeInstanceOf(DiagramValidationError);
    expect(mockedInvokeBedrockText).not.toHaveBeenCalled();
  });

  it('V1-2/V1-4 rejects malformed model output without returning a partial scene', async () => {
    mockedInvokeBedrockText.mockResolvedValue('{"title":"Broken","nodes":[]}');

    await expect(generateDiagramFromPrompt('project-a', 'Build a flow', 'user-1'))
      .rejects.toBeInstanceOf(DiagramAiGenerationError);
  });

  it('V1-4 ignores edges that reference nodes outside the validated graph', async () => {
    mockedInvokeBedrockText.mockResolvedValue(JSON.stringify({
      title: 'Small graph',
      nodes: [
        { id: 'one', label: 'One' },
        { id: 'two', label: 'Two' },
      ],
      edges: [
        { from: 'one', to: 'two' },
        { from: 'two', to: 'missing' },
      ],
    }));

    const result = await generateDiagramFromPrompt('project-a', 'Build a flow', 'user-1');

    const mermaid = result.scene.appState[APEX_AI_MERMAID_APP_STATE_KEY] as string;
    expect(mermaid).toContain('one --> two');
    expect(mermaid).not.toContain('missing');
  });
});
