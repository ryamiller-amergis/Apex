import type { AiFeature } from '../../shared/types/aiCostAnalytics';

export interface ArtifactBedrockUsageCtx {
  feature: AiFeature;
  project: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
}

export function uniqueThreadIds(...ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function putThreadLabel(
  labels: Record<string, string>,
  threadId: string | null | undefined,
  label: string,
): void {
  if (threadId) labels[threadId] = label;
}

/** PRD page: generate (PRD+backlog), optional test cases, validation, assistant. */
export function prdUsageThreadLabels(prd: {
  chatThreadId?: string | null;
  prdAssistantThreadId?: string | null;
  validationThreadId?: string | null;
  latestTestCase?: { chatThreadId?: string | null } | null;
}): Record<string, string> {
  const labels: Record<string, string> = {};
  putThreadLabel(labels, prd.chatThreadId, 'Generate');
  putThreadLabel(labels, prd.latestTestCase?.chatThreadId, 'Test cases');
  putThreadLabel(labels, prd.validationThreadId, 'Validation');
  putThreadLabel(labels, prd.prdAssistantThreadId, 'Assistant');
  return labels;
}

export function designDocUsageThreadLabels(doc: {
  chatThreadId?: string | null;
  docAssistantThreadId?: string | null;
  validationThreadId?: string | null;
}): Record<string, string> {
  const labels: Record<string, string> = {};
  putThreadLabel(labels, doc.chatThreadId, 'Generate');
  putThreadLabel(labels, doc.validationThreadId, 'Validation');
  putThreadLabel(labels, doc.docAssistantThreadId, 'Assistant');
  return labels;
}

export function prdPendingUsageSteps(prd: {
  status?: string | null;
  testCasesRequired?: boolean;
  latestTestCase?: { status?: string | null } | null;
}): string[] {
  const pending: string[] = [];
  if (prd.testCasesRequired !== false && prd.latestTestCase?.status === 'generating') {
    pending.push('Test cases');
  }
  if (prd.status === 'validating') pending.push('Validation');
  return pending;
}

export function designDocPendingUsageSteps(doc: { status?: string | null }): string[] {
  return doc.status === 'validating' ? ['Validation'] : [];
}

/** Prefer the owning thread, then skill/feature — steps can use different models. */
export function labelUsageRun(opts: {
  threadId?: string | null;
  feature?: string | null;
  skillPath?: string | null;
  threadLabels?: Record<string, string>;
}): string {
  const threadId = opts.threadId ?? '';
  const fromThread = threadId ? opts.threadLabels?.[threadId] : undefined;
  if (fromThread) return fromThread;

  const skill = (opts.skillPath ?? '').toLowerCase();
  const feature = (opts.feature ?? '').toLowerCase();
  if (skill.includes('create-test-case') || feature === 'test-case') return 'Test cases';
  if (
    skill.includes('prd-spec-review') ||
    skill.includes('design-doc-validation') ||
    skill.includes('document-validation') ||
    feature === 'design-doc-validation'
  ) {
    return 'Validation';
  }
  if (skill.includes('to-prd') || feature === 'prd') return 'Generate';
  if (feature === 'design-doc') return 'Generate';
  if (feature === 'prd-review') return 'Edit';
  if (feature === 'interview') return 'Interview';
  if (feature === 'adr') return 'ADR';
  if (feature === 'design-prototype') return 'Prototype';
  if (feature === 'design-plan') return 'Design plan';
  return 'Agent run';
}

export function prototypeUsageCtx(project: string | undefined, prototypeId: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-prototype',
    project: project ?? 'unknown',
    entityType: 'design-prototype',
    entityId: prototypeId,
  };
}

export function designPlanUsageCtx(project: string, planId: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-plan',
    project,
    entityType: 'design-plan',
    entityId: planId,
  };
}

export function prdReviewUsageCtx(project: string, prdId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'prd-review',
    project,
    entityType: 'prd',
    entityId: prdId,
    userId,
  };
}

export function designDocUsageCtx(project: string, designDocId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'design-doc',
    project,
    entityType: 'design-doc',
    entityId: designDocId,
    userId,
  };
}

export function adrUsageCtx(project: string, adrId: string, userId?: string): ArtifactBedrockUsageCtx {
  return {
    feature: 'adr',
    project,
    entityType: 'adr',
    entityId: adrId,
    userId,
  };
}
