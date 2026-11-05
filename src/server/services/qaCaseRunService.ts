import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseRuns } from '../db/schema';
import type {
  QaLabCaseRun,
  QaLabCaseRunState,
  QaLabRunAttachment,
  QaLabRunBug,
  QaLabRunOutcome,
  QaLabRunStepResult,
  QaLabRunTarget,
  QaLabSaveCaseRunRequest,
} from '../../shared/types/qaLab';
import { findAdoSuiteCase, projectAreaPath, publishedCasesFrom } from './adoTestCaseSuiteService';
import type { AzureDevOpsService } from './azureDevOps';
import { QaCaseNotFoundError } from './qaCaseRegenerationService';

export const MAX_RUN_COMMENT_LENGTH = 4000;
export const MAX_RUN_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_ATTACHMENTS = 20;

export type QaCaseRunAdo = Pick<
  AzureDevOpsService,
  'getTestCaseRunTarget' | 'uploadWorkItemAttachment' | 'publishManualTestResult' | 'createBugWorkItem' | 'linkBugToTestResult'
>;

export class QaCaseRunInputError extends Error {}

type RunRow = typeof qaCaseRuns.$inferSelect;

interface RunCase {
  project: string;
  sourceSnapshot: unknown;
  adoTestCaseId: number;
  preferred?: { planId: number; suiteId: number };
  parentWorkItemId: number | null;
}

interface RunUser {
  id: string;
  name: string | null;
}

const NOT_PUBLISHED = 'Publish this case to a Test Plan suite before running it.';

export async function getCaseRunState(suiteId: string, localCaseId: string, ado: QaCaseRunAdo): Promise<QaLabCaseRunState> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  if (!runCase) return { target: null, unavailableReason: NOT_PUBLISHED, draft: null, lastPublished: null };
  const target = await ado.getTestCaseRunTarget(runCase.adoTestCaseId, runCase.preferred);
  const [draft, lastPublished] = await Promise.all([findDraft(runCase), findLastPublished(runCase)]);
  return {
    target,
    ...(target ? {} : { unavailableReason: `Test Case ${runCase.adoTestCaseId} is in no Test Plan suite. ${NOT_PUBLISHED}` }),
    draft: draft ? toRun(draft) : null,
    lastPublished: lastPublished ? toRun(lastPublished) : null,
  };
}

export async function saveCaseRun(
  suiteId: string,
  localCaseId: string,
  input: QaLabSaveCaseRunRequest,
  user: RunUser,
  ado: QaCaseRunAdo,
): Promise<QaLabCaseRun> {
  const values = validateSave(input);
  const runCase = await requireRunCase(suiteId, localCaseId);
  const draft = await findOrCreateDraft(runCase, user, ado);
  return toRun(await updateRun(draft.id, values));
}

export async function addRunAttachment(
  suiteId: string,
  localCaseId: string,
  file: { fileName: string; content: Buffer; stepId?: number },
  user: RunUser,
  ado: QaCaseRunAdo,
): Promise<QaLabCaseRun> {
  if (file.content.length === 0) throw new QaCaseRunInputError('The file is empty');
  if (file.content.length > MAX_RUN_ATTACHMENT_BYTES) {
    throw new QaCaseRunInputError('Attachments can be up to 10 MB');
  }
  const runCase = await requireRunCase(suiteId, localCaseId);
  const draft = await findOrCreateDraft(runCase, user, ado);
  if (draft.attachments.length >= MAX_RUN_ATTACHMENTS) {
    throw new QaCaseRunInputError(`A run can have up to ${MAX_RUN_ATTACHMENTS} attachments`);
  }
  const uploaded = await ado.uploadWorkItemAttachment(file.fileName, file.content);
  const attachment: QaLabRunAttachment = {
    id: uploaded.id,
    fileName: file.fileName,
    size: file.content.length,
    url: uploaded.url,
    ...(file.stepId !== undefined ? { stepId: file.stepId } : {}),
  };
  return toRun(await updateRun(draft.id, { attachments: [...draft.attachments, attachment] }));
}

export async function removeRunAttachment(suiteId: string, localCaseId: string, attachmentId: string): Promise<QaLabCaseRun> {
  const runCase = await requireRunCase(suiteId, localCaseId);
  const draft = await findDraft(runCase);
  if (!draft) throw new QaCaseNotFoundError('This case has no run in progress');
  return toRun(await updateRun(draft.id, {
    attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId),
  }));
}

/**
 * Files a Bug for the run in progress, or for the last published run when none is.
 * The Bug is a child of the PBI and tested by the Test Case.
 */
export async function createRunBug(suiteId: string, localCaseId: string, ado: QaCaseRunAdo): Promise<QaLabCaseRun> {
  const runCase = await requireRunCase(suiteId, localCaseId);
  const run = (await findDraft(runCase)) ?? (await findLastPublished(runCase));
  if (!run) throw new QaCaseRunInputError('Record a failed result before filing a Bug');
  const failure = describeFailure(run);
  if (!failure) {
    throw new QaCaseRunInputError('Mark the case or a step Failed and add a comment before filing a Bug');
  }
  if (runCase.parentWorkItemId === null) {
    throw new QaCaseRunInputError('This case has no PBI to file the Bug under');
  }
  const target = await ado.getTestCaseRunTarget(runCase.adoTestCaseId, { planId: run.adoPlanId, suiteId: run.adoSuiteId });
  if (!target) throw new QaCaseRunInputError(`Test Case ${runCase.adoTestCaseId} could not be read from Azure DevOps`);

  const title = `Failed: ${target.title}`.slice(0, 255);
  const created = await ado.createBugWorkItem({
    title,
    reproStepsHtml: buildReproStepsHtml(target, run, failure),
    parentId: runCase.parentWorkItemId,
    testCaseId: runCase.adoTestCaseId,
    areaPath: projectAreaPath(runCase.project, runCase.sourceSnapshot),
    attachments: run.attachments.map(({ url, fileName }) => ({ url, fileName })),
  });
  if (run.adoRunId !== null && run.adoResultId !== null) {
    await ado.linkBugToTestResult(created.id, run.adoRunId, run.adoResultId);
  }
  const bug: QaLabRunBug = { id: created.id, url: created.url, title };
  return toRun(await updateRun(run.id, { bugs: [...run.bugs, bug] }));
}

export async function publishCaseRun(suiteId: string, localCaseId: string, ado: QaCaseRunAdo): Promise<QaLabCaseRun> {
  const runCase = await requireRunCase(suiteId, localCaseId);
  const draft = await findDraft(runCase);
  if (!draft) throw new QaCaseRunInputError('Record a result before publishing');
  if (!draft.outcome) throw new QaCaseRunInputError('Mark the case Passed or Failed before publishing');
  const target = await ado.getTestCaseRunTarget(runCase.adoTestCaseId, { planId: draft.adoPlanId, suiteId: draft.adoSuiteId });
  if (!target) throw new QaCaseRunInputError(`Test Case ${runCase.adoTestCaseId} is in no Test Plan suite`);

  const published = await ado.publishManualTestResult({
    planId: target.planId,
    suiteId: target.suiteId,
    testCaseId: runCase.adoTestCaseId,
    title: target.title,
    outcome: adoOutcome(draft.outcome),
    comment: draft.comment,
    steps: draft.stepResults.flatMap((step) => (step.outcome
      ? [{ stepId: step.stepId, outcome: adoOutcome(step.outcome), comment: step.comment }]
      : [])),
    attachments: draft.attachments.map(({ url, fileName, stepId }) => ({
      url,
      fileName,
      ...(stepId !== undefined ? { stepId } : {}),
    })),
    bugIds: draft.bugs.map((bug) => bug.id),
  });
  return toRun(await updateRun(draft.id, {
    status: 'published',
    adoPlanId: target.planId,
    adoSuiteId: target.suiteId,
    adoRunId: published.runId,
    adoResultId: published.resultId,
    adoRunUrl: published.runUrl,
    publishedAt: new Date().toISOString(),
  }));
}

/** The failed steps and the comment that explains them, or null when there is nothing to file. */
export function describeFailure(run: Pick<RunRow, 'outcome' | 'comment' | 'stepResults'>): {
  failedSteps: QaLabRunStepResult[];
} | null {
  const failedSteps = run.stepResults.filter((step) => step.outcome === 'failed');
  if (run.outcome !== 'failed' && failedSteps.length === 0) return null;
  const explained = run.comment.trim().length > 0 || failedSteps.some((step) => step.comment.trim().length > 0);
  return explained ? { failedSteps } : null;
}

export function buildReproStepsHtml(
  target: QaLabRunTarget,
  run: Pick<RunRow, 'comment' | 'stepResults'>,
  failure: { failedSteps: QaLabRunStepResult[] },
): string {
  const parts = [
    `<p>Found while running <a href="${escapeHtml(target.adoTestCaseUrl)}">Test Case ${target.adoTestCaseId}: ${escapeHtml(target.title)}</a> in ${escapeHtml(target.planName)} &gt; ${escapeHtml(target.suiteName)}.</p>`,
  ];
  if (failure.failedSteps.length > 0) {
    const steps = new Map(target.steps.map((step) => [step.stepId, step]));
    parts.push('<ol>');
    for (const result of failure.failedSteps) {
      const step = steps.get(result.stepId);
      parts.push([
        `<li><b>Step ${step?.order ?? result.stepId}:</b> ${multiline(step?.action ?? '')}`,
        step?.expected ? `<br/><b>Expected:</b> ${multiline(step.expected)}` : '',
        result.comment.trim() ? `<br/><b>Actual:</b> ${multiline(result.comment)}` : '',
        '</li>',
      ].join(''));
    }
    parts.push('</ol>');
  }
  if (run.comment.trim()) parts.push(`<p><b>Notes:</b> ${multiline(run.comment)}</p>`);
  return parts.join('');
}

async function resolveRunCase(suiteId: string, localCaseId: string): Promise<RunCase | null> {
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { project: true, sourceSnapshot: true, testCasesJson: true, publishedCases: true },
  });
  if (!suite) throw new QaCaseNotFoundError('QA suite not found');
  const match = findAdoSuiteCase(suite.testCasesJson, localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${localCaseId} is not in this suite`);
  const ledger = publishedCasesFrom(suite.publishedCases).find((entry) => entry.localCaseId === localCaseId);
  const existing = match.testCase.existing as { adoTestCaseId?: unknown } | undefined;
  const existingId = typeof existing?.adoTestCaseId === 'number' ? existing.adoTestCaseId : null;
  const adoTestCaseId = ledger?.adoTestCaseId ?? existingId;
  if (adoTestCaseId === null) return null;
  return {
    project: suite.project,
    sourceSnapshot: suite.sourceSnapshot,
    adoTestCaseId,
    ...(ledger?.testPlanId !== undefined && ledger.testSuiteId !== undefined
      ? { preferred: { planId: ledger.testPlanId, suiteId: ledger.testSuiteId } }
      : {}),
    parentWorkItemId: ledger?.parentWorkItemId ?? match.parentWorkItemId,
  };
}

async function requireRunCase(suiteId: string, localCaseId: string): Promise<RunCase> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  if (!runCase) throw new QaCaseRunInputError(NOT_PUBLISHED);
  return runCase;
}

function findDraft(runCase: RunCase): Promise<RunRow | undefined> {
  return db.query.qaCaseRuns.findFirst({
    where: and(
      eq(qaCaseRuns.project, runCase.project),
      eq(qaCaseRuns.adoTestCaseId, runCase.adoTestCaseId),
      eq(qaCaseRuns.status, 'draft'),
    ),
  });
}

function findLastPublished(runCase: RunCase): Promise<RunRow | undefined> {
  return db.query.qaCaseRuns.findFirst({
    where: and(
      eq(qaCaseRuns.project, runCase.project),
      eq(qaCaseRuns.adoTestCaseId, runCase.adoTestCaseId),
      eq(qaCaseRuns.status, 'published'),
    ),
    orderBy: [desc(qaCaseRuns.publishedAt)],
  });
}

async function findOrCreateDraft(runCase: RunCase, user: RunUser, ado: QaCaseRunAdo): Promise<RunRow> {
  const existing = await findDraft(runCase);
  if (existing) return existing;
  const target = await ado.getTestCaseRunTarget(runCase.adoTestCaseId, runCase.preferred);
  if (!target) throw new QaCaseRunInputError(`Test Case ${runCase.adoTestCaseId} is in no Test Plan suite. ${NOT_PUBLISHED}`);
  const [row] = await db
    .insert(qaCaseRuns)
    .values({
      project: runCase.project,
      adoTestCaseId: runCase.adoTestCaseId,
      adoPlanId: target.planId,
      adoSuiteId: target.suiteId,
      parentWorkItemId: runCase.parentWorkItemId,
      createdBy: user.id,
      createdByName: user.name,
    })
    .onConflictDoNothing()
    .returning();
  const draft = row ?? (await findDraft(runCase));
  if (!draft) throw new Error('Failed to start the run');
  return draft;
}

async function updateRun(id: string, values: Partial<typeof qaCaseRuns.$inferInsert>): Promise<RunRow> {
  const [row] = await db
    .update(qaCaseRuns)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(qaCaseRuns.id, id))
    .returning();
  if (!row) throw new QaCaseNotFoundError('The run no longer exists');
  return row;
}

function validateSave(input: QaLabSaveCaseRunRequest): Pick<RunRow, 'outcome' | 'comment' | 'stepResults'> {
  if (!isOutcomeOrNull(input?.outcome)) throw new QaCaseRunInputError('outcome must be passed, failed, or null');
  if (typeof input.comment !== 'string' || input.comment.length > MAX_RUN_COMMENT_LENGTH) {
    throw new QaCaseRunInputError(`comment must be up to ${MAX_RUN_COMMENT_LENGTH} characters`);
  }
  if (!Array.isArray(input.stepResults)) throw new QaCaseRunInputError('stepResults must be a list');
  const seen = new Set<number>();
  const stepResults = input.stepResults.map((step) => {
    if (!Number.isInteger(step?.stepId) || seen.has(step.stepId)) {
      throw new QaCaseRunInputError('Each step result needs a unique stepId');
    }
    if (!isOutcomeOrNull(step.outcome)) throw new QaCaseRunInputError('A step outcome must be passed, failed, or null');
    if (typeof step.comment !== 'string' || step.comment.length > MAX_RUN_COMMENT_LENGTH) {
      throw new QaCaseRunInputError(`A step comment must be up to ${MAX_RUN_COMMENT_LENGTH} characters`);
    }
    seen.add(step.stepId);
    return { stepId: step.stepId, outcome: step.outcome, comment: step.comment };
  });
  return { outcome: input.outcome, comment: input.comment, stepResults };
}

function isOutcomeOrNull(value: unknown): value is QaLabRunOutcome | null {
  return value === null || value === 'passed' || value === 'failed';
}

function adoOutcome(outcome: QaLabRunOutcome): 'Passed' | 'Failed' {
  switch (outcome) {
    case 'passed':
      return 'Passed';
    case 'failed':
      return 'Failed';
    default: {
      const unhandled: never = outcome;
      throw new Error(`Unhandled outcome ${String(unhandled)}`);
    }
  }
}

function toRun(row: RunRow): QaLabCaseRun {
  return {
    id: row.id,
    status: row.status,
    outcome: row.outcome ?? null,
    comment: row.comment,
    stepResults: row.stepResults,
    attachments: row.attachments,
    bugs: row.bugs,
    adoRunUrl: row.adoRunUrl,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function multiline(value: string): string {
  return escapeHtml(value.trim()).replace(/\r?\n/g, '<br/>');
}
