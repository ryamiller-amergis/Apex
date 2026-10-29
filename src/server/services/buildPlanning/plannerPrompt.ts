/**
 * Planner prompts. The reuse list is a starting point. The plan file on the
 * integration branch is the contract the validator reads.
 */
import type { PlanViolation } from '../../../shared/buildPlanSchema';
import type { BuildRequirement, BuildRiskDecision } from '../../../shared/types/build';
import { redactText } from '../buildRedactionService';
import { buildContextNotesPath, buildPlanFilePath } from './plannerResult';

export type PlannerPromptMode = 'full' | 'small' | 'repair';

export interface PlannerStandardsPointers {
  designSystemPath: string;
  designSystemHash: string;
  codingRulesPath: string;
  codingRulesHash: string;
  codeMapPath: string;
  codeMapHash: string;
}

export interface BuildPlannerPromptInput {
  mode: PlannerPromptMode;
  buildRunId: string;
  integrationBranch: string;
  brief: string;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  standards: PlannerStandardsPointers;
  catalogExcerpt: string;
  catalogBudgetBytes?: number;
  violations?: PlanViolation[];
}

const DEFAULT_CATALOG_BUDGET_BYTES = 24_000;

export function buildPlannerPrompt(input: BuildPlannerPromptInput): string {
  const budget = input.catalogBudgetBytes ?? DEFAULT_CATALOG_BUDGET_BYTES;
  const catalog = clipBytes(input.catalogExcerpt, budget);
  const lines = [
    `Mode: ${input.mode}`,
    'You are a staff engineer planning a build. You do not implement product code in this session except for the scaffold on the full path.',
    `Integration branch: ${input.integrationBranch}`,
    `Write the plan JSON to ${buildPlanFilePath(input.buildRunId)} and commit it on that branch.`,
    `Write context notes to ${buildContextNotesPath(input.buildRunId)} and set contextNotesPath to that path.`,
    'The reuse list is a starting point, not a limit. Every task needs a reuse entry or a justification with the searches you ran and a conclusion.',
    '',
    'Approved brief:',
    input.brief.trim(),
    '',
    'Requirements:',
    ...input.requirements.map((row) => `- ${row.id}${row.retired ? ' (retired)' : ''}: ${row.text}`),
    '',
    'Risk decisions:',
    ...input.riskDecisions.map((row) => `- ${row.id} (${row.rating}): ${row.decision}`),
    '',
    'Standards contract (paths and hashes only):',
    `- design system ${input.standards.designSystemPath} ${input.standards.designSystemHash}`,
    `- coding rules ${input.standards.codingRulesPath} ${input.standards.codingRulesHash}`,
    `- code map ${input.standards.codeMapPath} ${input.standards.codeMapHash}`,
    '',
    'Component catalog excerpt:',
    catalog || '(none)',
  ];

  // A repair retries a full-path plan, so it needs the full-path rules too.
  if (input.mode === 'full' || input.mode === 'repair') {
    lines.push(
      '',
      'Full path: set classification to "full" and include a scaffoldManifest. In this same session, commit the scaffold from the plan manifest (shared types, migration and schema, router mount, route and navigation entries pointing at empty components, empty test files) and the context-notes file.',
    );
  }
  if (input.mode === 'repair') {
    lines.push('Scaffold files and context notes already on the branch do not need to be committed again.');
  }
  if (input.mode === 'small') {
    lines.push(
      '',
      'Small path: write a short plan, then implement on the integration branch. Do not commit a scaffold manifest.',
    );
  }
  if (input.mode === 'repair') {
    lines.push('', 'The previous plan failed these checks. Commit a corrected plan file.');
    for (const violation of input.violations ?? []) {
      const keys = violation.taskKeys?.join(', ');
      const subject = violation.requirementId ?? violation.riskDecisionId ?? violation.path ?? '';
      lines.push(`- ${violation.code}${keys ? ` tasks ${keys}` : ''}${subject ? ` ${subject}` : ''}: ${violation.message}`);
    }
  }
  return redactText(lines.join('\n'));
}

function clipBytes(value: string, budget: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= budget) return value;
  return buffer.subarray(0, budget).toString('utf8');
}
