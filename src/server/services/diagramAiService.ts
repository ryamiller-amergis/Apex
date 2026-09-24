import {
  DiagramAiGenerationError,
  DiagramValidationError,
  type ExcalidrawScene,
  type GenerateDiagramResponse,
} from '../../shared/types/diagram';
import {
  APEX_AI_MERMAID_APP_STATE_KEY,
  graphToMermaid,
} from '../../shared/utils/graphToMermaid';
import { invokeBedrockText } from './bedrockService';

const MAX_PROMPT_LENGTH = 4_000;
const MAX_NODES = 20;
const MAX_EDGES = 40;

interface GeneratedNode {
  id: string;
  label: string;
}

interface GeneratedEdge {
  from: string;
  to: string;
}

interface GeneratedGraph {
  title: string;
  nodes: GeneratedNode[];
  edges: GeneratedEdge[];
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new DiagramAiGenerationError();
  }
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as unknown;
  } catch {
    throw new DiagramAiGenerationError();
  }
}

function requireShortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function parseGraph(text: string): GeneratedGraph {
  const value = extractJson(text);
  if (!value || typeof value !== 'object') {
    throw new DiagramAiGenerationError();
  }
  const raw = value as Record<string, unknown>;
  const title = requireShortString(raw.title, 120);
  if (!title || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new DiagramAiGenerationError();
  }
  if (raw.nodes.length < 1 || raw.nodes.length > MAX_NODES || raw.edges.length > MAX_EDGES) {
    throw new DiagramAiGenerationError();
  }

  const nodes: GeneratedNode[] = [];
  const nodeIds = new Set<string>();
  for (const candidate of raw.nodes) {
    if (!candidate || typeof candidate !== 'object') {
      throw new DiagramAiGenerationError();
    }
    const item = candidate as Record<string, unknown>;
    const id = requireShortString(item.id, 60);
    const label = requireShortString(item.label, 100);
    if (!id || !label || nodeIds.has(id)) {
      throw new DiagramAiGenerationError();
    }
    nodeIds.add(id);
    nodes.push({ id, label });
  }

  const edges: GeneratedEdge[] = [];
  for (const candidate of raw.edges) {
    if (!candidate || typeof candidate !== 'object') continue;
    const item = candidate as Record<string, unknown>;
    const from = requireShortString(item.from, 60);
    const to = requireShortString(item.to, 60);
    if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) continue;
    edges.push({ from, to });
  }

  return { title, nodes, edges };
}

/**
 * AI diagrams are materialized on the client via @excalidraw/mermaid-to-excalidraw
 * (same pipeline as Excalidraw's built-in Mermaid import) for correct labels and edges.
 */
function buildScene(graph: GeneratedGraph): ExcalidrawScene {
  return {
    elements: [],
    appState: {
      viewBackgroundColor: '#ffffff',
      [APEX_AI_MERMAID_APP_STATE_KEY]: graphToMermaid(graph),
    },
    files: {},
  };
}

function buildPrompt(concept: string): string {
  return [
    'Create a concise semantic graph for an editable whiteboard Diagram.',
    'Return JSON only with this exact shape:',
    '{"title":"short title","nodes":[{"id":"stable-id","label":"short label"}],"edges":[{"from":"node-id","to":"node-id"}]}',
    `Use 1-${MAX_NODES} nodes and no more than ${MAX_EDGES} directed edges.`,
    'Use unique node ids. Every edge endpoint must reference a node id.',
    'Do not add edge labels; relationship meaning should be clear from node labels and direction.',
    'Keep node labels under 100 characters. Do not include markdown or Excalidraw JSON.',
    '',
    `User concept: ${concept}`,
  ].join('\n');
}

export async function generateDiagramFromPrompt(
  projectId: string,
  prompt: string,
  userId: string,
): Promise<GenerateDiagramResponse> {
  const concept = typeof prompt === 'string' ? prompt.trim() : '';
  if (!concept) {
    throw new DiagramValidationError('prompt is required', 'DIAGRAM_AI_PROMPT_REQUIRED');
  }
  if (concept.length > MAX_PROMPT_LENGTH) {
    throw new DiagramValidationError(
      `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer`,
      'DIAGRAM_AI_PROMPT_TOO_LONG',
    );
  }

  const response = await invokeBedrockText(
    buildPrompt(concept),
    {
      feature: 'other',
      project: projectId,
      entityType: 'diagram-generation',
      userId,
    },
    { maxTokens: 4096 },
  );
  const graph = parseGraph(response);
  return {
    title: graph.title,
    scene: buildScene(graph),
  };
}
