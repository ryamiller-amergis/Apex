/**
 * Builds the prompt for the final check agent (FEAT-012, TBI-023 / S5).
 */
import type {
  BuildHashedPath,
  BuildQualityManifestSnapshot,
} from '../../../shared/types/build';
import { MAX_REPAIR_ATTEMPTS } from '../../../shared/types/buildFinalCheck';
import { redactText } from '../buildRedactionService';

export type QualityManifestInput =
  | BuildQualityManifestSnapshot
  | {
      unitFull: string;
      unitRelated: string;
      typeCheck: string;
      lint: string;
    };

export interface FinalCheckPromptInput {
  integrationBranch: string;
  baseCommit: string;
  qualityManifest: QualityManifestInput;
  standardsContract: {
    designSystemFile: BuildHashedPath;
    codingRules: BuildHashedPath;
    codeMap: BuildHashedPath;
  };
  contextNotesPath: string | null;
  repairAttemptsUsed: number;
  priorReportSummary?: string | null;
}

function normalizeManifest(manifest: QualityManifestInput): {
  unitFull: string;
  unitRelated: string;
  typeCheck: string;
  lint: string;
} {
  if ('unitFull' in manifest) {
    return manifest;
  }
  return {
    unitFull: manifest.unitSuite,
    unitRelated: manifest.relatedTests,
    typeCheck: manifest.typeCheck,
    lint: manifest.lint,
  };
}

export function buildFinalCheckPrompt(input: FinalCheckPromptInput): string {
  const commands = normalizeManifest(input.qualityManifest);
  const remaining = Math.max(0, MAX_REPAIR_ATTEMPTS - input.repairAttemptsUsed);
  const budgetLine =
    remaining === 1
      ? '1 repair attempt left'
      : `${remaining} repair attempts left`;
  const modeGuidance =
    remaining === 0
      ? 'Mode: report-only (0 repair attempts left — do not modify files; run checks and report only).'
      : `Mode: final-check (${budgetLine} — you may fix failing checks in-session, then re-run all checks).`;

  const lines: string[] = [
    '# Build Final Check Instructions',
    '',
    'Follow `.cursor/skills/build-final-check/SKILL.md` and `.cursor/skills/build-final-check/standards-review.md`.',
    '',
    '## Target Branch and Base Commit',
    `- Integration branch: \`${input.integrationBranch}\``,
    `- Base commit: \`${input.baseCommit}\``,
    '',
    '## Quality Manifest Commands',
    `- unit_full: \`${commands.unitFull}\``,
    `- unit_related: \`${commands.unitRelated}\``,
    `- type_check: \`${commands.typeCheck}\``,
    `- lint: \`${commands.lint}\``,
    '',
    '## Frozen Standards Contract (open and read these first)',
    `- designSystemFile: \`${input.standardsContract.designSystemFile.path}\` (hash: \`${input.standardsContract.designSystemFile.hash}\`)`,
    `- codingRules: \`${input.standardsContract.codingRules.path}\` (hash: \`${input.standardsContract.codingRules.hash}\`)`,
    `- codeMap: \`${input.standardsContract.codeMap.path}\` (hash: \`${input.standardsContract.codeMap.hash}\`)`,
    `- contextNotesPath: \`${input.contextNotesPath ?? 'none'}\``,
    '',
    '## Repair Budget',
    `- ${budgetLine}`,
    `- ${modeGuidance}`,
  ];

  if (input.priorReportSummary) {
    lines.push(
      '',
      '## Prior Check Report Summary',
      redactText(input.priorReportSummary).slice(0, 500)
    );
  }

  lines.push(
    '',
    '## Output Format',
    'End your final message with a fenced `apex-final-check-report` JSON block.'
  );

  return lines.join('\n');
}
