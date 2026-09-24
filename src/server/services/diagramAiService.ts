import {
  DiagramAiGenerationError,
  DiagramValidationError,
  type ExcalidrawScene,
  type GenerateDiagramResponse,
} from '../../shared/types/diagram';
import { invokeBedrockText } from './bedrockService';

const MAX_PROMPT_LENGTH = 4_000;
const MAX_NODES = 20;
const MAX_EDGES = 40;
/** Grid cell size — boxes auto-size to label text inside each cell. */
const NODE_CELL_WIDTH = 280;
const NODE_CELL_HEIGHT = 140;
const COLUMN_GAP = 100;
const ROW_GAP = 80;

interface GeneratedNode {
  id: string;
  label: string;
}

interface GeneratedEdge {
  from: string;
  to: string;
  label?: string;
}

interface GeneratedGraph {
  title: string;
  nodes: GeneratedNode[];
  edges: GeneratedEdge[];
}

interface PositionedNode extends GeneratedNode {
  x: number;
  y: number;
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
    const label = requireShortString(item.label, 80) ?? undefined;
    edges.push({ from, to, label });
  }

  return { title, nodes, edges };
}

function nodeElementId(nodeId: string): string {
  return `ai-node-${nodeId}`;
}

/** Approximate node center for grid layout (boxes auto-size to label text). */
function nodeCenter(node: PositionedNode): { x: number; y: number } {
  return {
    x: node.x + NODE_CELL_WIDTH / 2,
    y: node.y + NODE_CELL_HEIGHT / 2,
  };
}

/**
 * Excalidraw skeleton elements (labels on shapes). The client runs
 * convertToExcalidrawElements, which binds labels and sizes boxes to fit text.
 */
function buildScene(graph: GeneratedGraph): ExcalidrawScene {
  const columns = Math.min(3, Math.ceil(Math.sqrt(graph.nodes.length)));
  const positioned: PositionedNode[] = graph.nodes.map((node, index) => ({
    ...node,
    x: 100 + (index % columns) * (NODE_CELL_WIDTH + COLUMN_GAP),
    y: 100 + Math.floor(index / columns) * (NODE_CELL_HEIGHT + ROW_GAP),
  }));
  const positions = new Map(positioned.map((node) => [node.id, node]));

  const nodeElements = positioned.map((node) => ({
    type: 'rectangle',
    id: nodeElementId(node.id),
    x: node.x,
    y: node.y,
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    backgroundColor: '#e7f5ff',
    roundness: { type: 3 },
    label: {
      text: node.label,
      fontSize: 20,
      fontFamily: 1,
      textAlign: 'center',
      verticalAlign: 'middle',
    },
  }));

  const arrows = graph.edges.map((edge, index) => {
    const from = positions.get(edge.from)!;
    const to = positions.get(edge.to)!;
    const start = nodeCenter(from);
    const end = nodeCenter(to);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    return {
      type: 'arrow',
      id: `ai-arrow-${index}`,
      x: start.x,
      y: start.y,
      width: deltaX,
      height: deltaY,
      points: [[0, 0], [deltaX, deltaY]],
      strokeColor: '#1e1e1e',
      strokeWidth: 2,
      endArrowhead: 'arrow',
      ...(edge.label ? { label: { text: edge.label } } : {}),
    };
  });

  return {
    // Shapes before arrows so convertToExcalidrawElements can resolve labels first.
    elements: [...nodeElements, ...arrows],
    appState: {
      viewBackgroundColor: '#ffffff',
    },
    files: {},
  };
}

function buildPrompt(concept: string): string {
  return [
    'Create a concise semantic graph for an editable whiteboard Diagram.',
    'Return JSON only with this exact shape:',
    '{"title":"short title","nodes":[{"id":"stable-id","label":"short label"}],"edges":[{"from":"node-id","to":"node-id","label":"optional short label"}]}',
    `Use 1-${MAX_NODES} nodes and no more than ${MAX_EDGES} directed edges.`,
    'Use unique node ids. Every edge endpoint must reference a node id.',
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
