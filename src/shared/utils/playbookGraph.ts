import type { PlaybookGraph, PlaybookGraphNode } from '../types/playbook';

function withoutPublishStamp(
  node: PlaybookGraphNode
): Omit<PlaybookGraphNode, 'stepTypeVersion' | 'agentPolicy'> {
  const { stepTypeVersion: _version, agentPolicy: _policy, ...authorNode } = node;
  return authorNode;
}

/** Key order from jsonb must not count as a different graph. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)])
    );
  }
  return value;
}

/**
 * True when two graphs are the same authoring content.
 *
 * Publish stamps `stepTypeVersion` and `agentPolicy` onto the immutable copy only.
 * Those fields are not an edit, so they must not mark a draft unpublished or cause
 * a demo seed to publish the same graph again.
 */
export function playbookAuthorGraphsMatch(left: PlaybookGraph, right: PlaybookGraph): boolean {
  const normalize = (graph: PlaybookGraph) =>
    stable({
      nodes: graph.nodes.map(withoutPublishStamp),
      edges: graph.edges,
    });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
