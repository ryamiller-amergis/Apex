import ELK from 'elkjs/lib/elk.bundled.js';
import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';

const elk = new ELK();

export async function layoutPlaybookGraph(
  graph: PlaybookGraph
): Promise<PlaybookLayoutPositions> {
  if (graph.nodes.length === 0) return {};

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '48',
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: 180,
      height: 56,
    })),
    edges: graph.edges.map((edge, index) => ({
      id: `e-${index}`,
      sources: [edge.from],
      targets: [edge.to],
    })),
  };

  const layout = await elk.layout(elkGraph);
  const positions: PlaybookLayoutPositions = {};
  for (const child of layout.children ?? []) {
    if (child.id && typeof child.x === 'number' && typeof child.y === 'number') {
      positions[child.id] = { x: child.x, y: child.y };
    }
  }
  return positions;
}
