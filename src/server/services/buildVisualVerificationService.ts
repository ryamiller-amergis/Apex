import type { BuildVisualBrief } from '../../shared/buildVisualBrief';
import type { EvidenceBlock } from './builds/evidenceBlockParser';

export interface VisualQualityResult {
  passed: boolean;
  findings: string[];
}

export function evaluateVisualQualityFromEvidence(input: {
  visualBrief: BuildVisualBrief | null;
  block: EvidenceBlock | null;
}): VisualQualityResult {
  if (!input.visualBrief) {
    return { passed: true, findings: [] };
  }
  if (!input.block) {
    return {
      passed: false,
      findings: ['The build finished without structured evidence for visual review.'],
    };
  }

  const findings: string[] = [];
  const review = input.block.visualReview;
  if (!review?.completed) {
    findings.push('The agent did not complete a visual self-review before finishing.');
  }
  if (review?.findings?.length) {
    findings.push(...review.findings);
  }

  const snapshotRefs = input.block.entries.flatMap((entry) =>
    entry.testReferences.filter((ref) =>
      /snapshot|screenshot|visual|playwright/i.test(`${ref.file} ${ref.name}`),
    ),
  );
  if (snapshotRefs.length === 0) {
    findings.push(
      'No Playwright visual snapshot tests were recorded for the changed screen.',
    );
  }

  const rationale = review?.componentReuseRationale?.trim() ?? '';
  if (!rationale) {
    findings.push(
      'Evidence must explain which catalog components were reused or why custom UI was chosen.',
    );
  }

  if (input.block.standardsReview && input.block.standardsReview.findings.length > 0) {
    findings.push(...input.block.standardsReview.findings);
  }

  return { passed: findings.length === 0, findings };
}
