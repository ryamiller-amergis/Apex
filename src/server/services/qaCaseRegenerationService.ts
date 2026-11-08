import fs from 'fs';
import { and, asc, desc, eq, lte } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseComments, qaCaseRegenerations } from '../db/schema';
import type {
  QaAdoTestPlanOption,
  QaLabCaseComment,
  QaLabCaseRegeneration,
  QaLabCaseReview,
} from '../../shared/types/qaLab';
import { getDefaultModel } from './appSettingsService';
import {
  canThisInstanceFailGeneration,
  isThreadRunAlive,
} from './agentRunReaperService';
import {
  ADO_TEST_SUITE_WATCHER_INTERVAL_MS,
  AdoTestSuiteConflictError,
  buildSyntheticAdoBacklog,
  cleanupWorkspace,
  dispatchQaLabRun,
  findAdoSuiteCase,
  findOutputFile,
  narrowGenerationTargets,
  publishedCasesFrom,
  qaLabRepository,
  readTestPlanOptions,
  renderSyntheticPrd,
  renderTestPlanFile,
  renderTestPlanSection,
  replaceAdoSuiteCase,
  sanitizeSlug,
  summarizeCoverage,
  type AdoQaContextReader,
} from './adoTestCaseSuiteService';
import { saveDocumentInputSnapshot } from './aiRunV2/documentInputSnapshot';
import { AzureDevOpsService } from './azureDevOps';
import { usesV2DocumentTransport } from './backgroundWorkflowRouter';
import {
  createThread,
  isThreadIdle,
  updateThreadKickoffContext,
} from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import { normalizeTestCase } from './testCaseLookupService';
import { writeThreadFolderFile } from './threadFolder';

const WATCHER_MAX_ATTEMPTS = 180;
const CASE_OUTPUT_PATTERN = /\.case\.json$/i;

const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();

export class QaCaseNotFoundError extends Error {}

type RegenerationRow = typeof qaCaseRegenerations.$inferSelect;

export async function getCaseReview(suiteId: string): Promise<QaLabCaseReview> {
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
    columns: { publishedCases: true },
  });
  if (!suite) throw new QaCaseNotFoundError('QA suite not found');
  const published = publishedIds(suite.publishedCases);

  const comments = await db.query.qaCaseComments.findMany({
    where: eq(qaCaseComments.suiteId, suiteId),
    orderBy: [asc(qaCaseComments.createdAt)],
  });
  const runs = await db.query.qaCaseRegenerations.findMany({
    where: eq(qaCaseRegenerations.suiteId, suiteId),
    orderBy: [desc(qaCaseRegenerations.createdAt)],
  });
  const latest = new Map<string, RegenerationRow>();
  for (const run of runs) {
    if (!latest.has(run.localCaseId)) latest.set(run.localCaseId, run);
  }

  return {
    comments: comments.map(toComment),
    regenerations: [...latest.values()].map((run) => toRegeneration(run, published)),
  };
}

export async function addCaseComment(input: {
  suiteId: string;
  localCaseId: string;
  body: string;
  authorId: string;
  authorName: string | null;
}): Promise<QaLabCaseComment> {
  const suite = await loadReadySuite(input.suiteId);
  if (!findAdoSuiteCase(suite.testCasesJson, input.localCaseId)) {
    throw new QaCaseNotFoundError(`Case ${input.localCaseId} is not in this suite`);
  }
  const [row] = await db
    .insert(qaCaseComments)
    .values({
      suiteId: input.suiteId,
      localCaseId: input.localCaseId,
      body: input.body.trim(),
      authorId: input.authorId,
      authorName: input.authorName,
    })
    .returning();
  if (!row) throw new Error('Failed to save the comment');
  return toComment(row);
}

export async function regenerateAdoTestCase(input: {
  suiteId: string;
  localCaseId: string;
  userId: string;
  model?: string;
  /** Reader override. Defaults to AzureDevOpsService for the project. */
  ado?: AdoQaContextReader;
}): Promise<QaLabCaseRegeneration> {
  const suite = await loadReadySuite(input.suiteId);
  const match = findAdoSuiteCase(suite.testCasesJson, input.localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${input.localCaseId} is not in this suite`);
  if (publishedIds(suite.publishedCases).has(input.localCaseId)) {
    throw new AdoTestSuiteConflictError('Published cases cannot be regenerated. Change them in Azure DevOps.');
  }
  const comments = await db.query.qaCaseComments.findMany({
    where: and(
      eq(qaCaseComments.suiteId, input.suiteId),
      eq(qaCaseComments.localCaseId, input.localCaseId),
      eq(qaCaseComments.status, 'open'),
    ),
    orderBy: [asc(qaCaseComments.createdAt)],
  });
  if (comments.length === 0) {
    throw new AdoTestSuiteConflictError('Add a comment that says what to change first');
  }
  const running = await db.query.qaCaseRegenerations.findFirst({
    where: and(
      eq(qaCaseRegenerations.suiteId, input.suiteId),
      eq(qaCaseRegenerations.localCaseId, input.localCaseId),
      eq(qaCaseRegenerations.status, 'generating'),
    ),
    columns: { id: true },
  });
  if (running) throw new AdoTestSuiteConflictError('This case is already regenerating');

  const skillConfig = await resolveSkillConfig({ project: suite.project });
  if (!skillConfig?.testCaseSkillPath || !skillConfig.skillRepo) {
    throw new AdoTestSuiteConflictError('No test-case skill is configured for this project');
  }

  const snapshot = match.parentWorkItemId === null
    ? suite.sourceSnapshot
    : narrowGenerationTargets(suite.sourceSnapshot, [match.parentWorkItemId]);
  const slug = sanitizeSlug(`${suite.rootTitle}-${input.localCaseId}`);
  const testPlans = await readTestPlanOptions(input.ado ?? new AzureDevOpsService(suite.project));
  const backlog = buildSyntheticAdoBacklog(snapshot);
  const pbiIds = backlog.epics[0].features[0].items
    .filter((item) => item.type === 'PBI')
    .map((item) => item.id);
  const freeformContext = renderRegenerationContext({
    project: suite.project,
    rootWorkItemId: suite.rootWorkItemId,
    slug,
    localCaseId: input.localCaseId,
    currentCase: match.testCase,
    comments: comments.map((comment) => ({ body: comment.body, authorName: comment.authorName })),
    backlog,
    testPlans,
  });
  const model = input.model ?? skillConfig.testCaseModel ?? await getDefaultModel();

  const thread = await createThread(
    input.userId,
    {
      project: suite.project,
      agentModule: 'testCase',
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillProvider: skillConfig.skillProvider,
      skillPath: skillConfig.testCaseSkillPath,
      freeformContext,
      model,
      effort: skillConfig.testCaseEffort ?? undefined,
    },
    { skipAutoKickoff: true },
  );
  if (!thread.workspaceDir) throw new Error('Case regeneration thread has no workspace');
  // A V2 test-cases run will not start without a PRD and a backlog file.
  const sourceInputs = [
    { path: `.ai-pilot/output/${slug}.prd.md`, content: renderSyntheticPrd(snapshot, pbiIds) },
    { path: `.ai-pilot/output/${slug}.backlog.json`, content: JSON.stringify(backlog, null, 2) },
    ...renderTestPlanFile(testPlans),
  ];
  for (const file of [{ path: '.ai-pilot/kickoff-context.md', content: freeformContext }, ...sourceInputs]) {
    await writeThreadFolderFile({
      project: suite.project,
      workspaceDir: thread.workspaceDir,
      relativePath: file.path,
      content: file.content,
    });
  }
  await updateThreadKickoffContext(thread.id, freeformContext);
  await saveDocumentInputSnapshot(thread.id, sourceInputs);

  let row: RegenerationRow | undefined;
  try {
    [row] = await db
      .insert(qaCaseRegenerations)
      .values({
        suiteId: input.suiteId,
        localCaseId: input.localCaseId,
        chatThreadId: thread.id,
        previousCase: match.testCase,
        createdBy: input.userId,
      })
      .returning();
  } catch (error) {
    await cleanupWorkspace(thread.id, thread.workspaceDir);
    if (isUniqueViolation(error)) {
      throw new AdoTestSuiteConflictError('This case is already regenerating');
    }
    throw error;
  }
  if (!row) throw new Error('Failed to save the regeneration');
  const regeneration = row;

  void dispatchQaLabRun({
    threadId: thread.id,
    userId: input.userId,
    project: suite.project,
    repository: qaLabRepository(skillConfig),
    kickoffMessage: `Rewrite test case ${input.localCaseId} only, applying every reviewer comment in the kickoff context. Write .ai-pilot/output/${slug}.case.json and nothing else.`,
    logLabel: `regenerationId=${regeneration.id}`,
    onPreparationFailure: () => markFailed(regeneration.id, thread.id, 'Could not start the agent'),
  }).then(async (dispatched) => {
    if (!dispatched) return;
    const v2Transport = await usesV2DocumentTransport({
      userId: input.userId,
      project: suite.project,
      workflowClass: 'test-cases',
    });
    // @feature-flag:ai-runs-v2-transport start winner=enabled
    if (v2Transport) {
      // @feature-flag:ai-runs-v2-transport enabled-start
      // Harvest applies the V2 result through syncCaseRegenerationRunOutput.
      // @feature-flag:ai-runs-v2-transport enabled-end
    } else {
      // @feature-flag:ai-runs-v2-transport disabled-start
      startWatcher(regeneration.id, thread.id);
      // @feature-flag:ai-runs-v2-transport disabled-end
    }
    // @feature-flag:ai-runs-v2-transport end
  }).catch((error: unknown) => {
    console.error(`[qaCaseRegeneration] Routing check failed — regenerationId=${regeneration.id}`, error);
  });
  console.log(
    `[qaCaseRegeneration] Queued — regenerationId=${regeneration.id} suiteId=${input.suiteId} case=${input.localCaseId} threadId=${thread.id}`,
  );
  return toRegeneration(regeneration, new Set());
}

/**
 * Applies an Ask Apex edit to one case right away. `patch` fields replace the
 * case's own, so `steps` replaces every step. The old case is kept so QA can see
 * the change and restore it, as after a comment-driven rewrite.
 */
export async function editAdoTestCase(input: {
  suiteId: string;
  localCaseId: string;
  patch: Record<string, unknown>;
  userId: string;
}): Promise<QaLabCaseRegeneration> {
  const suite = await loadReadySuite(input.suiteId);
  const match = findAdoSuiteCase(suite.testCasesJson, input.localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${input.localCaseId} is not in this suite`);
  if (publishedIds(suite.publishedCases).has(input.localCaseId)) {
    throw new AdoTestSuiteConflictError('Published cases cannot be edited. Change them in Azure DevOps.');
  }
  const running = await db.query.qaCaseRegenerations.findFirst({
    where: and(
      eq(qaCaseRegenerations.suiteId, input.suiteId),
      eq(qaCaseRegenerations.localCaseId, input.localCaseId),
      eq(qaCaseRegenerations.status, 'generating'),
    ),
    columns: { id: true },
  });
  if (running) throw new AdoTestSuiteConflictError('This case is regenerating; wait for it to finish');

  const next: Record<string, unknown> = { ...match.testCase, ...input.patch, id: input.localCaseId };
  if (typeof next.title !== 'string' || next.title.trim().length === 0) {
    throw new AdoTestSuiteConflictError('A case needs a title');
  }
  if (!Array.isArray(next.steps) || next.steps.length === 0) {
    throw new AdoTestSuiteConflictError('A case needs at least one step');
  }
  const testCasesJson = replaceAdoSuiteCase(suite.testCasesJson, input.localCaseId, next);
  if (!testCasesJson) throw new QaCaseNotFoundError(`Case ${input.localCaseId} is not in this suite`);

  const now = new Date().toISOString();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(qaAdoTestSuites)
      .set({ testCasesJson, coverageSummary: summarizeCoverage(testCasesJson), updatedAt: now })
      .where(and(eq(qaAdoTestSuites.id, suite.id), eq(qaAdoTestSuites.status, 'ready')));
    const [inserted] = await tx
      .insert(qaCaseRegenerations)
      .values({
        suiteId: suite.id,
        localCaseId: input.localCaseId,
        status: 'ready',
        source: 'assistant',
        previousCase: match.testCase,
        createdBy: input.userId,
      })
      .returning();
    return inserted;
  });
  if (!row) throw new Error('Failed to save the edit');
  return toRegeneration(row, new Set());
}

/** Puts back the case a finished regeneration replaced. */
export async function restoreCaseRegeneration(
  suiteId: string,
  regenerationId: string,
): Promise<QaLabCaseRegeneration> {
  const suite = await loadReadySuite(suiteId);
  const run = await db.query.qaCaseRegenerations.findFirst({
    where: and(eq(qaCaseRegenerations.id, regenerationId), eq(qaCaseRegenerations.suiteId, suiteId)),
  });
  if (!run) throw new QaCaseNotFoundError('Regeneration not found');
  const latest = await db.query.qaCaseRegenerations.findFirst({
    where: and(
      eq(qaCaseRegenerations.suiteId, suiteId),
      eq(qaCaseRegenerations.localCaseId, run.localCaseId),
    ),
    orderBy: [desc(qaCaseRegenerations.createdAt)],
    columns: { id: true },
  });
  if (run.status !== 'ready' || latest?.id !== run.id) {
    throw new AdoTestSuiteConflictError('Only the latest finished regeneration can be undone');
  }
  if (publishedIds(suite.publishedCases).has(run.localCaseId)) {
    throw new AdoTestSuiteConflictError('Published cases cannot be restored. Change them in Azure DevOps.');
  }
  const previous = asRecord(run.previousCase);
  const testCasesJson = previous
    ? replaceAdoSuiteCase(suite.testCasesJson, run.localCaseId, previous)
    : null;
  if (!testCasesJson) throw new AdoTestSuiteConflictError('The case is no longer in this suite');

  const now = new Date().toISOString();
  const restored = await db.transaction(async (tx) => {
    await tx
      .update(qaAdoTestSuites)
      .set({ testCasesJson, coverageSummary: summarizeCoverage(testCasesJson), updatedAt: now })
      .where(and(eq(qaAdoTestSuites.id, suiteId), eq(qaAdoTestSuites.status, 'ready')));
    const [updated] = await tx
      .update(qaCaseRegenerations)
      .set({ status: 'restored', updatedAt: now })
      .where(and(eq(qaCaseRegenerations.id, run.id), eq(qaCaseRegenerations.status, 'ready')))
      .returning();
    return updated;
  });
  if (!restored) throw new AdoTestSuiteConflictError('The regeneration changed; reload and try again');
  return toRegeneration(restored, new Set());
}

/**
 * Post-run hook. Returns true when the thread belongs to a case regeneration.
 */
export async function syncCaseRegenerationRunOutput(
  chatThreadId: string,
  workspaceDir?: string,
): Promise<boolean> {
  const row = await db.query.qaCaseRegenerations.findFirst({
    where: eq(qaCaseRegenerations.chatThreadId, chatThreadId),
    columns: { id: true, status: true },
  });
  if (!row) return false;
  if (row.status !== 'generating') return true;

  const outcome = await applyRegenerationOutput(row.id, chatThreadId, workspaceDir);
  stopWatcher(row.id);
  if (outcome === 'missing') {
    await markFailed(row.id, chatThreadId, 'The agent finished without writing the case', workspaceDir);
  }
  return true;
}

export function resetCaseRegenerationWatchersForTests(): void {
  for (const interval of activeWatchers.values()) clearInterval(interval);
  activeWatchers.clear();
}

type ApplyOutcome = 'applied' | 'failed' | 'missing';

export async function applyRegenerationOutput(
  regenerationId: string,
  chatThreadId: string,
  workspaceDir?: string,
): Promise<ApplyOutcome> {
  const file = await findOutputFile(chatThreadId, CASE_OUTPUT_PATTERN, workspaceDir);
  if (!file) return 'missing';

  const fail = async (message: string): Promise<ApplyOutcome> => {
    await markFailed(regenerationId, chatThreadId, message, workspaceDir);
    return 'failed';
  };
  const generated = parseGeneratedCase(file);
  if (!generated) return fail('The agent wrote a case Apex could not read');

  const run = await db.query.qaCaseRegenerations.findFirst({
    where: eq(qaCaseRegenerations.id, regenerationId),
  });
  if (!run || run.status !== 'generating') return 'failed';
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, run.suiteId),
  });
  if (!suite || suite.status !== 'ready') return fail('The suite changed while the case was regenerating');
  if (publishedIds(suite.publishedCases).has(run.localCaseId)) {
    return fail('The case was published while it was regenerating');
  }
  const testCasesJson = replaceAdoSuiteCase(
    suite.testCasesJson,
    run.localCaseId,
    { ...generated, id: run.localCaseId },
  );
  if (!testCasesJson) return fail('The case was deleted while it was regenerating');

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(qaAdoTestSuites)
      .set({ testCasesJson, coverageSummary: summarizeCoverage(testCasesJson), updatedAt: now })
      .where(and(eq(qaAdoTestSuites.id, suite.id), eq(qaAdoTestSuites.status, 'ready')));
    await tx
      .update(qaCaseRegenerations)
      .set({ status: 'ready', updatedAt: now })
      .where(and(eq(qaCaseRegenerations.id, run.id), eq(qaCaseRegenerations.status, 'generating')));
    await tx
      .update(qaCaseComments)
      .set({ status: 'addressed', regenerationId: run.id, updatedAt: now })
      .where(and(
        eq(qaCaseComments.suiteId, suite.id),
        eq(qaCaseComments.localCaseId, run.localCaseId),
        eq(qaCaseComments.status, 'open'),
        lte(qaCaseComments.createdAt, run.createdAt),
      ));
  });
  await cleanupWorkspace(chatThreadId, workspaceDir);
  console.log(`[qaCaseRegeneration] Applied — regenerationId=${run.id} case=${run.localCaseId}`);
  return 'applied';
}

function parseGeneratedCase(file: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const candidate = asRecord(root?.testCase) ?? root;
  if (!candidate) return null;
  const title = candidate.title;
  const steps = candidate.steps;
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return candidate;
}

function renderRegenerationContext(input: {
  project: string;
  rootWorkItemId: number;
  slug: string;
  localCaseId: string;
  currentCase: Record<string, unknown>;
  comments: Array<{ body: string; authorName: string | null }>;
  backlog: unknown;
  testPlans: QaAdoTestPlanOption[];
}): string {
  return [
    '# Test Case Regeneration Context',
    `project: ${input.project}`,
    `root_work_item_id: ${input.rootWorkItemId}`,
    '',
    '## CRITICAL: Output File Instructions',
    '',
    `Write exactly one file with the built-in file writing tool: \`.ai-pilot/output/${input.slug}.case.json\`.`,
    'It holds ONE JSON object: a single test case shaped like an item of `testCases[]` in the',
    "skill's test-case-schema.json. Do not wrap it in `suites`. Write it once, complete.",
    `Keep \`id\` as \`${input.localCaseId}\`. Do NOT write \`.test-cases.json\`, \`.test-cases.md\`,`,
    'or any other file, and do not patch the backlog.',
    '',
    '## What to change',
    '',
    'Rewrite only the case below so it addresses every reviewer comment. Keep anything the',
    "comments do not ask to change. Follow the skill's case format, case volume, and placement",
    'rules. Do not split it into several cases. If a comment asks for something the work item',
    'does not support, keep the case as close to the comment as the work item allows.',
    '',
    '## Reviewer comments',
    '',
    ...input.comments.map((comment, index) =>
      `${index + 1}. ${comment.body.replace(/\s+/g, ' ').trim()}${comment.authorName ? ` (${comment.authorName})` : ''}`),
    '',
    '## Current case',
    '',
    '```json',
    JSON.stringify(input.currentCase, null, 2),
    '```',
    '',
    ...renderTestPlanSection(input.testPlans),
    '## Backlog JSON',
    '',
    'The work item this case tests. Personas are the product\'s own user types.',
    '',
    '```json',
    JSON.stringify(input.backlog, null, 2),
    '```',
  ].join('\n');
}

function startWatcher(regenerationId: string, chatThreadId: string): void {
  stopWatcher(regenerationId);
  let attempts = 0;
  const interval = setInterval(() => {
    attempts += 1;
    void poll(regenerationId, chatThreadId, attempts).catch((error: unknown) => {
      console.error(`[qaCaseRegeneration] Watcher tick failed (regenerationId=${regenerationId})`, error);
    });
  }, ADO_TEST_SUITE_WATCHER_INTERVAL_MS);
  interval.unref();
  activeWatchers.set(regenerationId, interval);
}

async function poll(regenerationId: string, chatThreadId: string, attempts: number): Promise<void> {
  const row = await db.query.qaCaseRegenerations.findFirst({
    where: eq(qaCaseRegenerations.id, regenerationId),
    columns: { status: true },
  });
  if (!row || row.status !== 'generating') {
    stopWatcher(regenerationId);
    return;
  }
  if (await applyRegenerationOutput(regenerationId, chatThreadId) !== 'missing') {
    stopWatcher(regenerationId);
    return;
  }
  if (attempts > WATCHER_MAX_ATTEMPTS) {
    stopWatcher(regenerationId);
    await markFailed(regenerationId, chatThreadId, 'Timed out waiting for the agent');
    return;
  }
  const agentFinished = isThreadIdle(chatThreadId) && !(await isThreadRunAlive(chatThreadId));
  if (!agentFinished) return;
  if (!(await canThisInstanceFailGeneration(chatThreadId))) return;
  stopWatcher(regenerationId);
  await markFailed(regenerationId, chatThreadId, 'The agent finished without writing the case');
}

function stopWatcher(regenerationId: string): void {
  const active = activeWatchers.get(regenerationId);
  if (active !== undefined) clearInterval(active);
  activeWatchers.delete(regenerationId);
}

async function markFailed(
  regenerationId: string,
  chatThreadId: string,
  error: string,
  workspaceDir?: string,
): Promise<void> {
  await db
    .update(qaCaseRegenerations)
    .set({ status: 'failed', error, updatedAt: new Date().toISOString() })
    .where(and(eq(qaCaseRegenerations.id, regenerationId), eq(qaCaseRegenerations.status, 'generating')));
  await cleanupWorkspace(chatThreadId, workspaceDir);
}

export async function loadReadySuite(suiteId: string) {
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, suiteId),
  });
  if (!suite) throw new QaCaseNotFoundError('QA suite not found');
  if (suite.status !== 'ready') {
    throw new AdoTestSuiteConflictError('Wait for generation to finish first');
  }
  return suite;
}

function publishedIds(value: unknown): Set<string> {
  return new Set(publishedCasesFrom(value).map((entry) => entry.localCaseId));
}

function toComment(row: typeof qaCaseComments.$inferSelect): QaLabCaseComment {
  return {
    id: row.id,
    localCaseId: row.localCaseId,
    body: row.body,
    status: row.status,
    authorName: row.authorName,
    createdAt: row.createdAt,
  };
}

function toRegeneration(row: RegenerationRow, published: Set<string>): QaLabCaseRegeneration {
  return {
    id: row.id,
    localCaseId: row.localCaseId,
    status: row.status,
    threadId: row.chatThreadId,
    error: row.error,
    canRestore: row.status === 'ready' && !published.has(row.localCaseId),
    source: row.source,
    previousCase: row.status === 'ready' ? normalizeTestCase(row.previousCase, '', 0) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
    ?? (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
