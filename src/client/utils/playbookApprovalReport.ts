import type { PlaybookGraphEdge } from '../../shared/types/playbook';

interface ReportStep {
  stepId: string;
  outputInline: Record<string, unknown> | null;
  completedAt?: string | null;
}

/** Ancestors of a node, nearest first. Loop copies (`work#1`) use the base id. */
function ancestorsNearestFirst(edges: readonly PlaybookGraphEdge[], stepId: string): string[] {
  const baseId = stepId.split('#')[0];
  const ordered: string[] = [];
  const seen = new Set<string>([baseId]);
  let frontier = [baseId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of edges) {
        if (edge.to !== id || seen.has(edge.from)) continue;
        seen.add(edge.from);
        ordered.push(edge.from);
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return ordered;
}

function reportText(output: Record<string, unknown> | null): string | null {
  const report = output?.reportMd ?? output?.output;
  return typeof report === 'string' && report.trim() ? report : null;
}

/**
 * The report the approval is about: the nearest earlier step that saved one.
 * A later or unrelated agent report in the same run is not a substitute.
 */
export function approvalReportForStep(
  steps: readonly ReportStep[],
  edges: readonly PlaybookGraphEdge[],
  stepId: string,
): string | null {
  for (const ancestor of ancestorsNearestFirst(edges, stepId)) {
    const matches = steps
      .filter((step) => step.stepId === ancestor || step.stepId.startsWith(`${ancestor}#`))
      .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')));
    for (const step of matches) {
      const report = reportText(step.outputInline);
      if (report) return report;
    }
  }
  return null;
}
