import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';
import { defaultPlaybookConnectorConfig } from '../../shared/types/playbookConnectors';

export type PlaybookFlowNodeData = {
  stepType: string;
  label: string;
  config: Record<string, unknown>;
  readOnly?: boolean;
  runStatus?: string;
};

export type PlaybookFlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: PlaybookFlowNodeData;
};

export type PlaybookFlowEdge = {
  id: string;
  source: string;
  target: string;
  data?: { condition?: string };
};

const NODE_TYPE = 'playbookStep';
const CONNECTOR_NODE_TYPE = 'playbookConnector';

export function flowNodeType(stepType: string): string {
  return stepType === 'connector' ? CONNECTOR_NODE_TYPE : NODE_TYPE;
}

export function initialStepConfig(stepType: string): Record<string, unknown> {
  return stepType === 'connector' ? defaultPlaybookConnectorConfig() : {};
}

export function graphToFlow(
  graph: PlaybookGraph,
  positions: PlaybookLayoutPositions,
  _labels: Record<string, string>,
): { nodes: PlaybookFlowNode[]; edges: PlaybookFlowEdge[] } {
  const nodes: PlaybookFlowNode[] = graph.nodes.map((node, index) => {
    const position = positions[node.id] ?? { x: 40 + (index % 4) * 340, y: 40 + Math.floor(index / 4) * 140 };
    return {
      id: node.id,
      type: flowNodeType(node.stepType),
      position,
      data: {
        stepType: node.stepType,
        label: node.id,
        config: node.config ?? {},
      },
    };
  });

  const edges: PlaybookFlowEdge[] = graph.edges.map((edge, index) => ({
    id: `edge-${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    ...(edge.condition ? { data: { condition: edge.condition } } : {}),
  }));

  return { nodes, edges };
}

export function flowToGraph(
  nodes: PlaybookFlowNode[],
  edges: PlaybookFlowEdge[],
): PlaybookGraph {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      stepType: node.data.stepType,
      ...(Object.keys(node.data.config).length ? { config: node.data.config } : {}),
    })),
    edges: edges.map((edge) => {
      const source = nodes.find((node) => node.id === edge.source);
      const condition = continuationCondition(source?.data, edge.target, edge.data?.condition);
      return {
        from: edge.source,
        to: edge.target,
        ...(condition ? { condition } : {}),
      };
    }),
  };
}

/**
 * Branch validation requires each outbound edge's `condition` to equal `whenTrue` or `whenFalse`.
 * The picker stores those as the target step id, so the edge condition is that same id.
 */
function continuationCondition(
  data: PlaybookFlowNodeData | undefined,
  target: string,
  existing: string | undefined,
): string | undefined {
  if (data?.stepType === 'branch') {
    if (data.config.whenTrue === target) return String(data.config.whenTrue);
    if (data.config.whenFalse === target) return String(data.config.whenFalse);
    return undefined;
  }
  return existing;
}

/** Make a branch step's chosen targets real outbound edges with those continuation names. */
export function syncBranchEdges(graph: PlaybookGraph): PlaybookGraph {
  const edges = graph.edges.filter((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.from);
    return source?.stepType !== 'branch';
  });
  for (const node of graph.nodes) {
    if (node.stepType !== 'branch') continue;
    const seen = new Set<string>();
    for (const key of ['whenTrue', 'whenFalse'] as const) {
      const target = node.config?.[key];
      if (typeof target !== 'string' || !target || seen.has(target)) continue;
      seen.add(target);
      edges.push({ from: node.id, to: target, condition: target });
    }
  }
  return { ...graph, edges };
}

export function positionsFromNodes(nodes: PlaybookFlowNode[]): PlaybookLayoutPositions {
  const positions: PlaybookLayoutPositions = {};
  for (const node of nodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  return positions;
}

/**
 * React Flow's drag-stop callback lists only the nodes that moved. Their new coordinates have to
 * be written over the full canvas, or every other step loses its saved position.
 */
export function positionsAfterDrag(
  existing: PlaybookFlowNode[],
  dragged: PlaybookFlowNode[],
): PlaybookLayoutPositions {
  const draggedById = new Map(dragged.map((node) => [node.id, node]));
  const merged = existing.map((node) => draggedById.get(node.id) ?? node);
  for (const node of dragged) {
    if (!existing.some((current) => current.id === node.id)) merged.push(node);
  }
  return positionsFromNodes(merged);
}

/** `notify-1`, `notify-2`, … — the lowest suffix not already used in the graph. */
export function newPlaybookNodeId(stepType: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let suffix = 1;
  while (taken.has(`${stepType}-${suffix}`)) suffix += 1;
  return `${stepType}-${suffix}`;
}
