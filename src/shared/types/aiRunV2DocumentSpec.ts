import {
  isEffortLevel,
  type EffortLevel,
} from './effort';
import type { BackgroundWorkflowClass } from './backgroundWorkflow';
import type { SkillProvider } from './projectSettings';

export const AI_RUN_V2_DOCUMENT_WORKFLOW_CLASSES = [
  'prd',
  'design-doc',
  'validation',
  'test-cases',
  'walkthrough-smart-tagging',
] as const satisfies readonly BackgroundWorkflowClass[];

export type AiRunV2DocumentScratchInput = Readonly<{
  path: string;
  content: string;
}>;

/**
 * Frozen App Service decisions consumed by the document worker.
 *
 * `effort: null` is an explicit decision to use the provider's model default;
 * absence is invalid because a worker may not invent that decision.
 */
export type AiRunV2DocumentSpecification = Readonly<{
  workloadLane: 'document';
  prompt: string;
  model: string;
  effort: EffortLevel | null;
  skillPath: string;
  skillContent: string;
  skillSha256: string;
  workflowClass: BackgroundWorkflowClass;
  projectId: string;
  threadId: string;
  deadlineMs: number;
  scratchInputs: ReadonlyArray<AiRunV2DocumentScratchInput>;
  groundedSha?: string;
  repository?: string;
  provider?: SkillProvider;
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isDocumentWorkflowClass(
  value: unknown,
): value is BackgroundWorkflowClass {
  return (
    typeof value === 'string'
    && (AI_RUN_V2_DOCUMENT_WORKFLOW_CLASSES as readonly string[]).includes(value)
  );
}

export function documentWorkflowRequiresRepository(
  workflowClass: BackgroundWorkflowClass,
): boolean {
  switch (workflowClass) {
    case 'prd':
    case 'design-doc':
    case 'test-cases':
      return true;
    case 'validation':
    case 'walkthrough-smart-tagging':
      return false;
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function isPortableScratchPath(value: string): boolean {
  return (
    value.startsWith('.ai-pilot/')
    && !value.includes('\\')
    && !value.split('/').includes('..')
  );
}

export function isAllowedDocumentScratchInputPath(
  workflowClass: BackgroundWorkflowClass,
  value: string,
): boolean {
  if (!isPortableScratchPath(value)) return false;
  if (
    value === '.ai-pilot/kickoff-context.md'
    || value === '.ai-pilot/session.json'
  ) {
    return true;
  }

  switch (workflowClass) {
    case 'prd':
      return value === '.ai-pilot/kickoff-transcript.md';
    case 'test-cases':
      return (
        /^\.ai-pilot\/output\/[^/]+\.prd\.md$/i.test(value)
        || /^\.ai-pilot\/output\/[^/]+\.backlog\.json$/i.test(value)
      );
    case 'design-doc':
    case 'validation':
    case 'walkthrough-smart-tagging':
      return false;
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function hasRequiredScratchInputs(
  workflowClass: BackgroundWorkflowClass,
  inputs: ReadonlyArray<AiRunV2DocumentScratchInput>,
): boolean {
  const paths = inputs.map((input) => input.path);
  switch (workflowClass) {
    case 'prd':
      return paths.includes('.ai-pilot/kickoff-transcript.md');
    case 'design-doc':
    case 'validation':
    case 'walkthrough-smart-tagging':
      return paths.includes('.ai-pilot/kickoff-context.md');
    case 'test-cases':
      return (
        paths.includes('.ai-pilot/kickoff-context.md')
        && paths.some((value) => /\.prd\.md$/i.test(value))
        && paths.some((value) => /\.backlog\.json$/i.test(value))
      );
    default: {
      const unhandled: never = workflowClass;
      throw new Error(`Unsupported document workflow: ${String(unhandled)}`);
    }
  }
}

function isSkillProvider(value: unknown): value is SkillProvider {
  return value === 'ado' || value === 'github';
}

export function isAiRunV2DocumentSpecification(
  value: unknown,
): value is AiRunV2DocumentSpecification {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.workloadLane !== 'document') return false;
  if (!isNonEmptyString(candidate.prompt)) return false;
  if (!isNonEmptyString(candidate.model)) return false;
  if (!Object.prototype.hasOwnProperty.call(candidate, 'effort')) return false;
  if (candidate.effort !== null && !isEffortLevel(candidate.effort)) return false;
  if (!isNonEmptyString(candidate.skillPath)) return false;
  if (!isNonEmptyString(candidate.skillContent)) return false;
  if (
    typeof candidate.skillSha256 !== 'string'
    || !/^[a-f0-9]{64}$/i.test(candidate.skillSha256)
  ) {
    return false;
  }
  if (!isDocumentWorkflowClass(candidate.workflowClass)) return false;
  if (!isNonEmptyString(candidate.projectId)) return false;
  if (!isNonEmptyString(candidate.threadId)) return false;
  if (
    typeof candidate.deadlineMs !== 'number'
    || !Number.isSafeInteger(candidate.deadlineMs)
    || candidate.deadlineMs <= 0
  ) {
    return false;
  }
  if (!Array.isArray(candidate.scratchInputs)) return false;

  const scratchInputs: AiRunV2DocumentScratchInput[] = [];
  const seenPaths = new Set<string>();
  for (const raw of candidate.scratchInputs) {
    if (!raw || typeof raw !== 'object') return false;
    const input = raw as Record<string, unknown>;
    if (!isNonEmptyString(input.path) || typeof input.content !== 'string') {
      return false;
    }
    if (
      !isAllowedDocumentScratchInputPath(candidate.workflowClass, input.path)
      || seenPaths.has(input.path)
    ) {
      return false;
    }
    seenPaths.add(input.path);
    scratchInputs.push({ path: input.path, content: input.content });
  }
  if (!hasRequiredScratchInputs(candidate.workflowClass, scratchInputs)) {
    return false;
  }

  for (const hostPathField of [
    'workspaceRef',
    'checkoutRef',
    'mirrorRef',
  ] as const) {
    if (candidate[hostPathField] !== undefined) return false;
  }
  for (const field of ['groundedSha', 'repository'] as const) {
    if (candidate[field] !== undefined && !isNonEmptyString(candidate[field])) {
      return false;
    }
  }
  if (candidate.provider !== undefined && !isSkillProvider(candidate.provider)) {
    return false;
  }
  if (
    documentWorkflowRequiresRepository(candidate.workflowClass)
    && (
      !isNonEmptyString(candidate.groundedSha)
      || !isNonEmptyString(candidate.repository)
      || !isSkillProvider(candidate.provider)
    )
  ) {
    return false;
  }
  return true;
}
