import ELK from 'elkjs/lib/elk.bundled.js';
import type { PlaybookGraph, PlaybookLayoutPositions } from '../../shared/types/playbook';

const elk = new ELK();

/** Upper bound of a rendered step node; `.flowNode` caps its width at 260px. */
export const PLAYBOOK_NODE_WIDTH = 260;
export const PLAYBOOK_NODE_HEIGHT = 64;

/** True when any two nodes would draw on top of each other. */
export function positionsOverlap(positions: PlaybookLayoutPositions): boolean {
  const points = Object.values(positions);
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      if (
        Math.abs(points[i].x - points[j].x) < PLAYBOOK_NODE_WIDTH
        && Math.abs(points[i].y - points[j].y) < PLAYBOOK_NODE_HEIGHT
      ) {
        return true;
      }
    }
  }
  return false;
}

export async function layoutPlaybookGraph(
  graph: PlaybookGraph
): Promise<PlaybookLayoutPositions> {
  if (graph.nodes.length === 0) return {};

  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: PLAYBOOK_NODE_WIDTH,
      height: PLAYBOOK_NODE_HEIGHT,
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
