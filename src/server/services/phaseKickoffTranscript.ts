export interface PhaseKickoffTranscriptInput {
  interviewTitle: string;
  originalPrompt?: string | null;
  requirementsSummary?: string | null;
  technicalSummary?: string | null;
}

function appendSection(lines: string[], heading: string, content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  lines.push(`## ${heading}`, '', trimmed, '');
}

/**
 * Build the deterministic requirements input consumed by the existing /to-prd
 * skill. Unconfigured or empty phase summaries are omitted entirely.
 */
export function renderPhaseKickoffTranscript(
  input: PhaseKickoffTranscriptInput,
): string {
  const lines = ['# Interview Kickoff Transcript', ''];
  appendSection(lines, 'Interview Title', input.interviewTitle);
  appendSection(lines, 'Original Prompt', input.originalPrompt ?? '');
  appendSection(
    lines,
    'Requirements Phase Summary',
    input.requirementsSummary ?? '',
  );
  appendSection(
    lines,
    'Technical Phase Summary',
    input.technicalSummary ?? '',
  );
  return lines.join('\n');
}
