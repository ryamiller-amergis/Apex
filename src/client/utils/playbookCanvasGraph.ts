import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';

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
};

const NODE_TYPE = 'playbookStep';

export function graphToFlow(
  graph: PlaybookGraph,
  positions: PlaybookLayoutPositions,
  _labels: Record<string, string>,
): { nodes: PlaybookFlowNode[]; edges: PlaybookFlowEdge[] } {
  const nodes: PlaybookFlowNode[] = graph.nodes.map((node, index) => {
    const position = positions[node.id] ?? { x: 40 + (index % 4) * 340, y: 40 + Math.floor(index / 4) * 140 };
    return {
      id: node.id,
      type: NODE_TYPE,
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
    edges: edges.map((edge) => ({ from: edge.source, to: edge.target })),
  };
}

export function positionsFromNodes(nodes: PlaybookFlowNode[]): PlaybookLayoutPositions {
  const positions: PlaybookLayoutPositions = {};
  for (const node of nodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y };
  }
  return positions;
}

/** `notify-1`, `notify-2`, … — the lowest suffix not already used in the graph. */
export function newPlaybookNodeId(stepType: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let suffix = 1;
  while (taken.has(`${stepType}-${suffix}`)) suffix += 1;
  return `${stepType}-${suffix}`;
}
