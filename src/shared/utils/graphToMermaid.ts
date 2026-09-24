export interface GraphForMermaid {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string }>;
}

/** Transient appState key — client materializes to Excalidraw elements; not persisted. */
export const APEX_AI_MERMAID_APP_STATE_KEY = 'apexAiMermaid';

function mermaidNodeId(rawId: string, used: Set<string>): string {
  const base = rawId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, 'n$1') || 'node';
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function escapeMermaidLabel(label: string): string {
  return label
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '#quot;')
    .replace(/\n/g, ' ');
}

/**
 * Builds a flowchart Mermaid definition for @excalidraw/mermaid-to-excalidraw.
 */
export function graphToMermaid(graph: GraphForMermaid): string {
  const usedIds = new Set<string>();
  const idByGraphId = new Map<string, string>();
  for (const node of graph.nodes) {
    idByGraphId.set(node.id, mermaidNodeId(node.id, usedIds));
  }

  const lines = ['flowchart TD'];
  for (const node of graph.nodes) {
    const mermaidId = idByGraphId.get(node.id)!;
    lines.push(`  ${mermaidId}["${escapeMermaidLabel(node.label)}"]`);
  }
  for (const edge of graph.edges) {
    const from = idByGraphId.get(edge.from);
    const to = idByGraphId.get(edge.to);
    if (!from || !to) continue;
    lines.push(`  ${from} --> ${to}`);
  }
  return lines.join('\n');
}
