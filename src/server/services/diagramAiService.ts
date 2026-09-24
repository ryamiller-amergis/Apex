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
const NODE_MIN_WIDTH = 120;
const NODE_MIN_HEIGHT = 72;
const NODE_FONT_SIZE = 20;
const NODE_LINE_HEIGHT = 1.25;
const NODE_PADDING_X = 24;
const NODE_PADDING_Y = 20;
const NODE_MAX_INNER_WIDTH = 240;
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
  width: number;
  height: number;
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

function estimateCharWidth(char: string): number {
  if (char === ' ') return NODE_FONT_SIZE * 0.28;
  if (/[iIlj1|!]/.test(char)) return NODE_FONT_SIZE * 0.34;
  if (/[WMmw@#%]/.test(char)) return NODE_FONT_SIZE * 0.62;
  return NODE_FONT_SIZE * 0.52;
}

function measureLineWidth(line: string): number {
  return [...line].reduce((sum, char) => sum + estimateCharWidth(char), 0);
}

function wrapLabel(label: string, maxInnerWidth: number): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines: string[] = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (measureLineWidth(candidate) <= maxInnerWidth) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines;
}

function measureNodeBox(label: string): { width: number; height: number } {
  let lines = wrapLabel(label, NODE_MAX_INNER_WIDTH);
  let innerWidth = Math.max(...lines.map(measureLineWidth), 40);
  if (innerWidth > NODE_MAX_INNER_WIDTH) {
    lines = wrapLabel(label, innerWidth);
    innerWidth = Math.max(...lines.map(measureLineWidth), 40);
  }
  const width = Math.max(
    NODE_MIN_WIDTH,
    Math.ceil(innerWidth + NODE_PADDING_X * 2),
  );
  const height = Math.max(
    NODE_MIN_HEIGHT,
    Math.ceil(lines.length * NODE_FONT_SIZE * NODE_LINE_HEIGHT + NODE_PADDING_Y * 2),
  );
  return { width, height };
}

function nodeElementId(nodeId: string): string {
  return `ai-node-${nodeId}`;
}

function layoutNodes(nodes: GeneratedNode[]): PositionedNode[] {
  const columns = Math.min(3, Math.ceil(Math.sqrt(nodes.length)));
  const sizes = nodes.map((node) => measureNodeBox(node.label));
  const rowCount = Math.ceil(nodes.length / columns);

  const colWidths = Array.from({ length: columns }, (_, col) => {
    let max = NODE_MIN_WIDTH;
    for (let index = col; index < nodes.length; index += columns) {
      max = Math.max(max, sizes[index].width);
    }
    return max;
  });

  const rowHeights = Array.from({ length: rowCount }, (_, row) => {
    let max = NODE_MIN_HEIGHT;
    for (let col = 0; col < columns; col += 1) {
      const index = row * columns + col;
      if (index >= nodes.length) break;
      max = Math.max(max, sizes[index].height);
    }
    return max;
  });

  return nodes.map((node, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = 100 + colWidths.slice(0, col).reduce((sum, width) => sum + width + COLUMN_GAP, 0);
    const y = 100 + rowHeights.slice(0, row).reduce((sum, height) => sum + height + ROW_GAP, 0);
    return {
      ...node,
      x,
      y,
      width: sizes[index].width,
      height: sizes[index].height,
    };
  });
}

/**
 * Excalidraw skeleton elements (labels on shapes). The client runs
 * convertToExcalidrawElements, which binds labels and sizes boxes to fit text.
 */
function buildScene(graph: GeneratedGraph): ExcalidrawScene {
  const positioned = layoutNodes(graph.nodes);
  const positions = new Map(positioned.map((node) => [node.id, node]));

  const nodeElements = positioned.map((node) => ({
    type: 'rectangle',
    id: nodeElementId(node.id),
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    strokeColor: '#1e1e1e',
    strokeWidth: 2,
    backgroundColor: '#e7f5ff',
    roundness: { type: 3 },
    label: {
      text: node.label,
      fontSize: NODE_FONT_SIZE,
      fontFamily: 1,
      textAlign: 'center',
      verticalAlign: 'middle',
    },
  }));

  const arrows = graph.edges.map((edge, index) => {
    const from = positions.get(edge.from)!;
    return {
      type: 'arrow',
      id: `ai-arrow-${index}`,
      x: from.x,
      y: from.y,
      start: { type: 'rectangle', id: nodeElementId(edge.from) },
      end: { type: 'rectangle', id: nodeElementId(edge.to) },
      strokeColor: '#1e1e1e',      strokeWidth: 2,
      endArrowhead: 'arrow',
    };
  });

  return {
    elements: [...nodeElements, ...arrows],    appState: {
      viewBackgroundColor: '#ffffff',
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
