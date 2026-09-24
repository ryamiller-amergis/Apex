import { DiagramAiGenerationError, DiagramValidationError } from '../../shared/types/diagram';
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

  it('V1-1/V1-4 turns a bounded Bedrock graph into an editable Excalidraw scene', async () => {
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
    expect(result.scene.files).toEqual({});
    expect(result.scene.elements.filter((element) => (
      (element as { type?: string }).type === 'rectangle'
    ))).toHaveLength(3);
    expect(result.scene.elements.filter((element) => (
      (element as { type?: string }).type === 'text'
    ))).toHaveLength(0);
    const rectangle = result.scene.elements.find((element) => (
      (element as { type?: string }).type === 'rectangle'
    )) as { label?: { text?: string; fontFamily?: number } };
    expect(rectangle.label?.text).toBe('Receive order');
    expect(rectangle.label?.fontFamily).toBe(1);
    expect(result.scene.elements.filter((element) => (
      (element as { type?: string }).type === 'arrow'
    ))).toHaveLength(2);
    const elementTypes = result.scene.elements.map(
      (element) => (element as { type?: string }).type,
    );
    expect(elementTypes.lastIndexOf('rectangle')).toBeGreaterThan(-1);
    expect(elementTypes.indexOf('arrow')).toBeGreaterThan(
      elementTypes.lastIndexOf('rectangle'),
    );
    const arrow = result.scene.elements.find((element) => (
      (element as { type?: string }).type === 'arrow'
    )) as {
      endArrowhead?: string | null;
      start?: { id?: string; type?: string };
      end?: { id?: string; type?: string };
      points?: unknown;
      label?: unknown;
    };
    expect(arrow.endArrowhead).toBe('arrow');    expect(arrow.start).toEqual({ type: 'rectangle', id: 'ai-node-request' });
    expect(arrow.end).toEqual({ type: 'rectangle', id: 'ai-node-validate' });
    expect(arrow.points).toBeUndefined();
    expect(arrow.label).toBeUndefined();
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

    expect(result.scene.elements.filter((element) => (
      (element as { type?: string }).type === 'arrow'
    ))).toHaveLength(1);
  });
});
