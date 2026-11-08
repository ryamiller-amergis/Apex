import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseRunFiles, qaCaseRuns } from '../db/schema';
import type {
  QaLabCaseRun,
  QaLabCaseRunState,
  QaLabRecordedStepResult,
  QaLabRunBug,
  QaLabRunOutcome,
  QaLabRunPublishResult,
  QaLabSaveCaseRunRequest,
  QaLabTestCaseStep,
} from '../../shared/types/qaLab';
import {
  caseRunSteps,
  findAdoSuiteCase,
  listAdoSuiteCases,
  projectAreaPath,
  publishedCasesFrom,
} from './adoTestCaseSuiteService';
import type { AzureDevOpsService } from './azureDevOps';
import { QaCaseNotFoundError } from './qaCaseRegenerationService';

export const MAX_RUN_COMMENT_LENGTH = 4000;
export const MAX_RUN_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_RUN_ATTACHMENTS = 20;

export type QaCaseRunAdo = Pick<
  AzureDevOpsService,
  | 'getTestCaseRunTarget'
  | 'uploadWorkItemAttachment'
  | 'publishManualTestResult'
  | 'createBugWorkItem'
  | 'linkBugToTestResult'
  | 'linkBugToTestCase'
>;

export class QaCaseRunInputError extends Error {}

type RunRow = typeof qaCaseRuns.$inferSelect;

interface RunCase {
  suiteId: string;
  localCaseId: string;
  project: string;
  sourceSnapshot: unknown;
  title: string;
  steps: QaLabTestCaseStep[];
  parentWorkItemId: number | null;
  /** The case's Test Case, once it is in Azure DevOps. */
  ado: { testCaseId: number; url: string; preferred?: { planId: number; suiteId: number } } | null;
}

interface RunUser {
  id: string;
  name: string | null;
}

const fileColumns = {
  id: qaCaseRunFiles.id,
  fileName: qaCaseRunFiles.fileName,
  size: qaCaseRunFiles.size,
  stepOrder: qaCaseRunFiles.stepOrder,
};

export async function getCaseRunState(suiteId: string, localCaseId: string): Promise<QaLabCaseRunState> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  const [draft, lastPublished] = await Promise.all([findDraft(runCase), findLastPublished(runCase)]);
  return {
    steps: runCase.steps,
    adoTestCase: runCase.ado ? { id: runCase.ado.testCaseId, url: runCase.ado.url } : null,
    draft: draft ? await toRun(draft, runCase.steps) : null,
    changedSteps: draft ? changedStepOrders(draft.stepResults, runCase.steps) : [],
    lastPublished: lastPublished ? await toRun(lastPublished) : null,
  };
}

export async function saveCaseRun(
  suiteId: string,
  localCaseId: string,
  input: QaLabSaveCaseRunRequest,
  user: RunUser,
): Promise<QaLabCaseRun> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  const values = validateSave(input, runCase.steps);
  const draft = await findOrCreateDraft(runCase, user);
  return toRun(await updateRun(draft.id, values), runCase.steps);
}

export async function addRunAttachment(
  suiteId: string,
  localCaseId: string,
  file: { fileName: string; contentType: string | null; content: Buffer; stepOrder?: number },
  user: RunUser,
): Promise<QaLabCaseRun> {
  if (file.content.length === 0) throw new QaCaseRunInputError('The file is empty');
  if (file.content.length > MAX_RUN_ATTACHMENT_BYTES) {
    throw new QaCaseRunInputError('Attachments can be up to 10 MB');
  }
  const runCase = await resolveRunCase(suiteId, localCaseId);
  if (file.stepOrder !== undefined && !runCase.steps.some((step) => step.order === file.stepOrder)) {
    throw new QaCaseRunInputError(`This case has no step ${file.stepOrder}`);
  }
  const draft = await findOrCreateDraft(runCase, user);
  const files = await listFiles(draft.id);
  if (files.length >= MAX_RUN_ATTACHMENTS) {
    throw new QaCaseRunInputError(`A run can have up to ${MAX_RUN_ATTACHMENTS} attachments`);
  }
  await db.insert(qaCaseRunFiles).values({
    runId: draft.id,
    stepOrder: file.stepOrder ?? null,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.content.length,
    content: file.content,
  });
  return toRun(await updateRun(draft.id, {}), runCase.steps);
}

/** A file of this case's draft or last published run. */
export async function getRunAttachmentFile(
  suiteId: string,
  localCaseId: string,
  fileId: string,
): Promise<{ fileName: string; contentType: string | null; content: Buffer }> {
  const [file] = await db
    .select({ fileName: qaCaseRunFiles.fileName, contentType: qaCaseRunFiles.contentType, content: qaCaseRunFiles.content })
    .from(qaCaseRunFiles)
    .innerJoin(qaCaseRuns, eq(qaCaseRuns.id, qaCaseRunFiles.runId))
    .where(and(
      eq(qaCaseRunFiles.id, fileId),
      eq(qaCaseRuns.suiteId, suiteId),
      eq(qaCaseRuns.localCaseId, localCaseId),
    ));
  if (!file) throw new QaCaseNotFoundError('Attachment not found');
  return file;
}

export async function removeRunAttachment(suiteId: string, localCaseId: string, fileId: string): Promise<QaLabCaseRun> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  const draft = await findDraft(runCase);
  if (!draft) throw new QaCaseNotFoundError('This case has no run in progress');
  await db.delete(qaCaseRunFiles).where(and(eq(qaCaseRunFiles.id, fileId), eq(qaCaseRunFiles.runId, draft.id)));
  return toRun(await updateRun(draft.id, {}), runCase.steps);
}

/**
 * Files a Bug in Azure DevOps for the run in progress, or for the last published run when
 * none is. The Bug is a child of the PBI; it is linked to the Test Case now when the case
 * is in Azure DevOps, otherwise when the case is published.
 */
export async function createRunBug(suiteId: string, localCaseId: string, ado: QaCaseRunAdo): Promise<QaLabCaseRun> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  const run = (await findDraft(runCase)) ?? (await findLastPublished(runCase));
  if (!run) throw new QaCaseRunInputError('Record a failed result before filing a Bug');
  const stepResults = run.status === 'draft' ? currentStepResults(run.stepResults, runCase.steps) : run.stepResults;
  const failure = describeFailure({ ...run, stepResults });
  if (!failure) {
    throw new QaCaseRunInputError('Mark the case or a step Failed and add a comment before filing a Bug');
  }
  if (runCase.parentWorkItemId === null) {
    throw new QaCaseRunInputError('This case has no PBI to file the Bug under');
  }

  const title = `Failed: ${runCase.title}`.slice(0, 255);
  const files = await uploadRunFiles(run.id, ado);
  const created = await ado.createBugWorkItem({
    title,
    reproStepsHtml: buildReproStepsHtml(
      { title: runCase.title, adoTestCaseId: runCase.ado?.testCaseId ?? null, adoTestCaseUrl: runCase.ado?.url ?? null },
      run.comment,
      failure,
    ),
    parentId: runCase.parentWorkItemId,
    ...(runCase.ado ? { testCaseId: runCase.ado.testCaseId } : {}),
    areaPath: projectAreaPath(runCase.project, runCase.sourceSnapshot),
    attachments: files,
  });
  if (run.adoRunId !== null && run.adoResultId !== null) {
    await ado.linkBugToTestResult(created.id, run.adoRunId, run.adoResultId);
  }
  const bug: QaLabRunBug = { id: created.id, url: created.url, title, linkedToTestCase: runCase.ado !== null };
  return toRun(await updateRun(run.id, { bugs: [...run.bugs, bug] }), runCase.steps);
}

/** Publishes the run in progress of a case that is already in Azure DevOps. */
export async function publishCaseRun(suiteId: string, localCaseId: string, ado: QaCaseRunAdo): Promise<QaLabCaseRun> {
  const runCase = await resolveRunCase(suiteId, localCaseId);
  const draft = await findDraft(runCase);
  if (!draft) throw new QaCaseRunInputError('Record a result before publishing');
  return toRun(await publishRun(runCase, draft, ado));
}

/**
 * Publishes every run in progress that has an outcome and whose case is now in Azure
 * DevOps. Suite publish calls this after it creates the Test Cases.
 */
export async function publishSuiteRuns(suiteId: string, ado: QaCaseRunAdo): Promise<QaLabRunPublishResult> {
  const drafts = await db.query.qaCaseRuns.findMany({
    where: and(eq(qaCaseRuns.suiteId, suiteId), eq(qaCaseRuns.status, 'draft'), isNotNull(qaCaseRuns.outcome)),
  });
  const result: QaLabRunPublishResult = { publishedLocalCaseIds: [], failures: [] };
  if (drafts.length === 0) return result;
  const runCases = await resolveSuiteRunCases(suiteId);
  for (const draft of drafts) {
    const runCase = runCases.get(draft.localCaseId);
    if (!runCase?.ado) continue;
    try {
      await publishRun(runCase, draft, ado);
      result.publishedLocalCaseIds.push(draft.localCaseId);
    } catch (error) {
      result.failures.push({
        localCaseId: draft.localCaseId,
        message: error instanceof Error ? error.message : 'Publishing the results failed',
      });
    }
  }
  return result;
}

/** The failed steps and the comment that explains them, or null when there is nothing to file. */
export function describeFailure(run: Pick<RunRow, 'outcome' | 'comment' | 'stepResults'>): {
  failedSteps: QaLabRecordedStepResult[];
} | null {
  const failedSteps = run.stepResults.filter((step) => step.outcome === 'failed');
  if (run.outcome !== 'failed' && failedSteps.length === 0) return null;
  const explained = run.comment.trim().length > 0 || failedSteps.some((step) => step.comment.trim().length > 0);
  return explained ? { failedSteps } : null;
}

export function buildReproStepsHtml(
  testCase: { title: string; adoTestCaseId: number | null; adoTestCaseUrl: string | null },
  comment: string,
  failure: { failedSteps: QaLabRecordedStepResult[] },
): string {
  const caseName = testCase.adoTestCaseId !== null && testCase.adoTestCaseUrl
    ? `<a href="${escapeHtml(testCase.adoTestCaseUrl)}">Test Case ${testCase.adoTestCaseId}: ${escapeHtml(testCase.title)}</a>`
    : `the QA Lab case "${escapeHtml(testCase.title)}"`;
  const parts = [`<p>Found while running ${caseName}.</p>`];
  if (failure.failedSteps.length > 0) {
    parts.push('<ol>');
    for (const step of failure.failedSteps) {
      parts.push([
        `<li><b>Step ${step.order}:</b> ${multiline(step.action)}`,
        step.expected ? `<br/><b>Expected:</b> ${multiline(step.expected)}` : '',
        step.comment.trim() ? `<br/><b>Actual:</b> ${multiline(step.comment)}` : '',
        '</li>',
      ].join(''));
    }
    parts.push('</ol>');
  }
  if (comment.trim()) parts.push(`<p><b>Notes:</b> ${multiline(comment)}</p>`);
  return parts.join('');
}

/** Step results whose step text no longer matches the case. */
export function changedStepOrders(results: QaLabRecordedStepResult[], steps: QaLabTestCaseStep[]): number[] {
  const byOrder = new Map(steps.map((step) => [step.order, step]));
  return results
    .filter((result) => {
      const step = byOrder.get(result.order);
      return !step || step.action !== result.action || step.expected !== result.expected;
    })
    .map((result) => result.order);
}

function currentStepResults(results: QaLabRecordedStepResult[], steps: QaLabTestCaseStep[]): QaLabRecordedStepResult[] {
  const changed = new Set(changedStepOrders(results, steps));
  return results.filter((result) => !changed.has(result.order));
}

async function publishRun(runCase: RunCase, draft: RunRow, ado: QaCaseRunAdo): Promise<RunRow> {
  if (!draft.outcome) throw new QaCaseRunInputError('Mark the case Passed or Failed before publishing');
  if (!runCase.ado) throw new QaCaseRunInputError('Publish the suite to send this case and its results to Azure DevOps');
  const testCaseId = runCase.ado.testCaseId;
  const target = await ado.getTestCaseRunTarget(testCaseId, runCase.ado.preferred);
  if (!target) throw new QaCaseRunInputError(`Test Case ${testCaseId} is in no Test Plan suite`);

  const stepIdByOrder = new Map(target.steps.map((step) => [step.order, step.stepId]));
  const stepResults = currentStepResults(draft.stepResults, runCase.steps);
  const files = await db
    .select({ fileName: qaCaseRunFiles.fileName, content: qaCaseRunFiles.content, stepOrder: qaCaseRunFiles.stepOrder })
    .from(qaCaseRunFiles)
    .where(eq(qaCaseRunFiles.runId, draft.id))
    .orderBy(asc(qaCaseRunFiles.createdAt));

  const bugs: QaLabRunBug[] = [];
  for (const bug of draft.bugs) {
    if (!bug.linkedToTestCase) await ado.linkBugToTestCase(bug.id, testCaseId);
    bugs.push({ ...bug, linkedToTestCase: true });
  }

  const published = await ado.publishManualTestResult({
    planId: target.planId,
    suiteId: target.suiteId,
    testCaseId,
    title: target.title,
    outcome: adoOutcome(draft.outcome),
    comment: draft.comment,
    steps: stepResults.flatMap((step) => {
      const stepId = stepIdByOrder.get(step.order);
      return step.outcome && stepId !== undefined
        ? [{ stepId, outcome: adoOutcome(step.outcome), comment: step.comment }]
        : [];
    }),
    attachments: files.map((file) => {
      const stepId = file.stepOrder === null ? undefined : stepIdByOrder.get(file.stepOrder);
      return { fileName: file.fileName, content: file.content, ...(stepId !== undefined ? { stepId } : {}) };
    }),
    bugIds: bugs.map((bug) => bug.id),
  });
  return updateRun(draft.id, {
    status: 'published',
    stepResults,
    bugs,
    adoTestCaseId: testCaseId,
    adoPlanId: target.planId,
    adoSuiteId: target.suiteId,
    adoRunId: published.runId,
    adoResultId: published.resultId,
    adoRunUrl: published.runUrl,
    publishedAt: new Date().toISOString(),
  });
}

/** Uploads the run's files that are not in Azure DevOps yet and returns every file's URL. */
async function uploadRunFiles(runId: string, ado: QaCaseRunAdo): Promise<Array<{ url: string; fileName: string }>> {
  const files = await db
    .select({ id: qaCaseRunFiles.id, fileName: qaCaseRunFiles.fileName, content: qaCaseRunFiles.content, adoUrl: qaCaseRunFiles.adoUrl })
    .from(qaCaseRunFiles)
    .where(eq(qaCaseRunFiles.runId, runId))
    .orderBy(asc(qaCaseRunFiles.createdAt));
  const uploaded: Array<{ url: string; fileName: string }> = [];
  for (const file of files) {
    let url = file.adoUrl;
    if (!url) {
      url = (await ado.uploadWorkItemAttachment(file.fileName, file.content)).url;
      await db.update(qaCaseRunFiles).set({ adoUrl: url }).where(eq(qaCaseRunFiles.id, file.id));
    }
    uploaded.push({ url, fileName: file.fileName });
  }
  return uploaded;
}

async function loadSuiteRow(suiteId: string) {
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { id: true, project: true, sourceSnapshot: true, testCasesJson: true, publishedCases: true },
  });
  if (!suite) throw new QaCaseNotFoundError('QA suite not found');
  return suite;
}

type SuiteRow = Awaited<ReturnType<typeof loadSuiteRow>>;

function toRunCase(
  suite: SuiteRow,
  localCaseId: string,
  match: { testCase: Record<string, unknown>; parentWorkItemId: number | null },
): RunCase {
  const ledger = publishedCasesFrom(suite.publishedCases).find((entry) => entry.localCaseId === localCaseId);
  const existing = match.testCase.existing as { adoTestCaseId?: unknown; url?: unknown } | undefined;
  const existingId = typeof existing?.adoTestCaseId === 'number' ? existing.adoTestCaseId : null;
  let ado: RunCase['ado'] = null;
  if (ledger) {
    ado = {
      testCaseId: ledger.adoTestCaseId,
      url: ledger.adoTestCaseUrl,
      ...(ledger.testPlanId !== undefined && ledger.testSuiteId !== undefined
        ? { preferred: { planId: ledger.testPlanId, suiteId: ledger.testSuiteId } }
        : {}),
    };
  } else if (existingId !== null) {
    ado = { testCaseId: existingId, url: typeof existing?.url === 'string' ? existing.url : '' };
  }
  return {
    suiteId: suite.id,
    localCaseId,
    project: suite.project,
    sourceSnapshot: suite.sourceSnapshot,
    title: typeof match.testCase.title === 'string' ? match.testCase.title : localCaseId,
    steps: caseRunSteps(match.testCase),
    parentWorkItemId: ledger?.parentWorkItemId ?? match.parentWorkItemId,
    ado,
  };
}

async function resolveRunCase(suiteId: string, localCaseId: string): Promise<RunCase> {
  const suite = await loadSuiteRow(suiteId);
  const match = findAdoSuiteCase(suite.testCasesJson, localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${localCaseId} is not in this suite`);
  return toRunCase(suite, localCaseId, match);
}

async function resolveSuiteRunCases(suiteId: string): Promise<Map<string, RunCase>> {
  const suite = await loadSuiteRow(suiteId);
  return new Map(listAdoSuiteCases(suite.testCasesJson)
    .map((match) => [match.localCaseId, toRunCase(suite, match.localCaseId, match)]));
}

function findDraft(runCase: RunCase): Promise<RunRow | undefined> {
  return db.query.qaCaseRuns.findFirst({
    where: and(
      eq(qaCaseRuns.suiteId, runCase.suiteId),
      eq(qaCaseRuns.localCaseId, runCase.localCaseId),
      eq(qaCaseRuns.status, 'draft'),
    ),
  });
}

function findLastPublished(runCase: RunCase): Promise<RunRow | undefined> {
  return db.query.qaCaseRuns.findFirst({
    where: and(
      eq(qaCaseRuns.suiteId, runCase.suiteId),
      eq(qaCaseRuns.localCaseId, runCase.localCaseId),
      eq(qaCaseRuns.status, 'published'),
    ),
    orderBy: [desc(qaCaseRuns.publishedAt)],
  });
}

async function findOrCreateDraft(runCase: RunCase, user: RunUser): Promise<RunRow> {
  const existing = await findDraft(runCase);
  if (existing) return existing;
  const [row] = await db
    .insert(qaCaseRuns)
    .values({
      suiteId: runCase.suiteId,
      localCaseId: runCase.localCaseId,
      project: runCase.project,
      adoTestCaseId: runCase.ado?.testCaseId ?? null,
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

function listFiles(runId: string) {
  return db.select(fileColumns).from(qaCaseRunFiles).where(eq(qaCaseRunFiles.runId, runId)).orderBy(asc(qaCaseRunFiles.createdAt));
}

function validateSave(
  input: QaLabSaveCaseRunRequest,
  steps: QaLabTestCaseStep[],
): Pick<RunRow, 'outcome' | 'comment' | 'stepResults'> {
  if (!isOutcomeOrNull(input?.outcome)) throw new QaCaseRunInputError('outcome must be passed, failed, or null');
  if (typeof input.comment !== 'string' || input.comment.length > MAX_RUN_COMMENT_LENGTH) {
    throw new QaCaseRunInputError(`comment must be up to ${MAX_RUN_COMMENT_LENGTH} characters`);
  }
  if (!Array.isArray(input.stepResults)) throw new QaCaseRunInputError('stepResults must be a list');
  const byOrder = new Map(steps.map((step) => [step.order, step]));
  const seen = new Set<number>();
  const stepResults = input.stepResults.map((result) => {
    const step = byOrder.get(result?.order);
    if (!step || seen.has(step.order)) throw new QaCaseRunInputError('Each step result needs a unique step of this case');
    if (!isOutcomeOrNull(result.outcome)) throw new QaCaseRunInputError('A step outcome must be passed, failed, or null');
    if (typeof result.comment !== 'string' || result.comment.length > MAX_RUN_COMMENT_LENGTH) {
      throw new QaCaseRunInputError(`A step comment must be up to ${MAX_RUN_COMMENT_LENGTH} characters`);
    }
    seen.add(step.order);
    return { order: step.order, outcome: result.outcome, comment: result.comment, action: step.action, expected: step.expected };
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

/** With `steps`, a draft's results for steps that changed since are left out. */
async function toRun(row: RunRow, steps?: QaLabTestCaseStep[]): Promise<QaLabCaseRun> {
  const files = await listFiles(row.id);
  return {
    id: row.id,
    status: row.status,
    outcome: row.outcome ?? null,
    comment: row.comment,
    stepResults: steps && row.status === 'draft' ? currentStepResults(row.stepResults, steps) : row.stepResults,
    attachments: files.map((file) => ({
      id: file.id,
      fileName: file.fileName,
      size: file.size,
      ...(file.stepOrder !== null ? { stepOrder: file.stepOrder } : {}),
    })),
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
