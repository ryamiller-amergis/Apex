import fs from 'fs';
import path from 'path';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseComments } from '../db/schema';
import type { QaLabCaseComment, QaLabCaseRegeneration } from '../../shared/types/qaLab';
import { getDefaultModel } from './appSettingsService';
import {
  AdoTestSuiteConflictError,
  appendAdoSuiteCase,
  deleteAdoTestCases,
  listAdoSuiteCases,
  publishedCasesFrom,
  readTestPlanOptions,
  renderTestPlanSection,
  summarizeCoverage,
  writeTestPlanFile,
  type AdoQaContextReader,
} from './adoTestCaseSuiteService';
import { AzureDevOpsService } from './azureDevOps';
import { createThread, getThread, updateThreadKickoffContext } from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import {
  addCaseComment,
  editAdoTestCase,
  loadReadySuite,
  QaCaseNotFoundError,
  regenerateAdoTestCase,
} from './qaCaseRegenerationService';

const ASSISTANT_AUTHOR_NAME = 'Ask Apex';
const THREAD_ID_PLACEHOLDER = '__THREAD_ID__';

/** The calling thread is not the Ask Apex thread of a QA suite. */
export class QaLabAssistantThreadError extends Error {}

type Suite = Awaited<ReturnType<typeof loadReadySuite>>;

/**
 * Returns the user's Ask Apex thread for one suite, refreshing its context.
 * `threadId` is the thread the client last used; another user's thread, or one
 * for a different suite, is replaced by a new thread.
 */
export async function openQaLabAssistantThread(input: {
  suiteId: string;
  userId: string;
  threadId?: string | null;
  /** Reader override. Defaults to AzureDevOpsService for the project. */
  ado?: AdoQaContextReader;
}): Promise<{ threadId: string }> {
  const suite = await loadReadySuite(input.suiteId);
  const skillConfig = await resolveSkillConfig({ project: suite.project });
  const testPlans = await readTestPlanOptions(input.ado ?? new AzureDevOpsService(suite.project));
  const comments = await openComments(suite.id);
  const render = (threadId: string) => renderAssistantContext({
    suite,
    threadId,
    comments,
    skillPath: skillConfig?.testCaseSkillPath ?? null,
    testPlanSection: renderTestPlanSection(testPlans),
  });

  const existing = input.threadId ? await getThread(input.threadId) : null;
  if (
    existing
    && existing.userId === input.userId
    && existing.kickoff.qaLabSuiteId === suite.id
    && existing.workspaceDir
  ) {
    await writeContext(existing.workspaceDir, existing.id, render(existing.id), testPlans);
    return { threadId: existing.id };
  }

  const thread = await createThread(
    input.userId,
    {
      project: suite.project,
      repo: skillConfig?.skillRepo ?? suite.project,
      branch: skillConfig?.skillBranch ?? 'main',
      skillProvider: skillConfig?.skillProvider ?? undefined,
      freeformContext: render(THREAD_ID_PLACEHOLDER),
      model: skillConfig?.testCaseModel ?? await getDefaultModel(),
      qaLabSuiteId: suite.id,
    },
    { skipAutoKickoff: true },
  );
  if (!thread.workspaceDir) throw new Error('Ask Apex thread has no workspace');
  await writeContext(thread.workspaceDir, thread.id, render(thread.id), testPlans);
  return { threadId: thread.id };
}

/** The suite a tool call may change: the one bound to the calling thread. */
export async function suiteIdForAssistantThread(threadId: string): Promise<{ suiteId: string; userId: string }> {
  const thread = await getThread(threadId);
  const suiteId = thread?.kickoff.qaLabSuiteId;
  if (!thread || !suiteId || !thread.userId) {
    throw new QaLabAssistantThreadError('This tool works only in QA Lab Ask Apex');
  }
  return { suiteId, userId: thread.userId };
}

export interface QaLabAssistantCaseView {
  localCaseId: string;
  pbiId: string;
  published: boolean;
  testCase: Record<string, unknown>;
}

export async function listAssistantCases(threadId: string): Promise<{
  rootWorkItemId: number;
  rootTitle: string;
  cases: QaLabAssistantCaseView[];
  openComments: Array<Pick<QaLabCaseComment, 'localCaseId' | 'body' | 'authorName'>>;
}> {
  const { suiteId } = await suiteIdForAssistantThread(threadId);
  const suite = await loadReadySuite(suiteId);
  const comments = await openComments(suiteId);
  return {
    rootWorkItemId: suite.rootWorkItemId,
    rootTitle: suite.rootTitle,
    cases: casesOf(suite),
    openComments: comments.map(({ localCaseId, body, authorName }) => ({ localCaseId, body, authorName })),
  };
}

export async function assistantEditCase(input: {
  threadId: string;
  localCaseId: string;
  patch: Record<string, unknown>;
}): Promise<QaLabCaseRegeneration> {
  const { suiteId, userId } = await suiteIdForAssistantThread(input.threadId);
  return editAdoTestCase({ suiteId, localCaseId: input.localCaseId, patch: input.patch, userId });
}

export async function assistantAddCase(input: {
  threadId: string;
  pbiId: string;
  testCase: Record<string, unknown>;
}): Promise<{ localCaseId: string }> {
  const { suiteId } = await suiteIdForAssistantThread(input.threadId);
  const suite = await loadReadySuite(suiteId);
  const { title, steps } = input.testCase;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new AdoTestSuiteConflictError('A case needs a title');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AdoTestSuiteConflictError('A case needs at least one step');
  }
  const appended = appendAdoSuiteCase(suite.testCasesJson, input.pbiId, input.testCase);
  if (!appended) throw new QaCaseNotFoundError(`No cases in this suite belong to ${input.pbiId}`);
  await db
    .update(qaAdoTestSuites)
    .set({
      testCasesJson: appended.testCasesJson,
      coverageSummary: summarizeCoverage(appended.testCasesJson),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(qaAdoTestSuites.id, suiteId), eq(qaAdoTestSuites.status, 'ready')));
  return { localCaseId: appended.localCaseId };
}

export async function assistantDeleteCase(input: {
  threadId: string;
  localCaseId: string;
}): Promise<{ deleted: boolean }> {
  const { suiteId } = await suiteIdForAssistantThread(input.threadId);
  const { deletedLocalCaseIds } = await deleteAdoTestCases(suiteId, [input.localCaseId]);
  return { deleted: deletedLocalCaseIds.includes(input.localCaseId) };
}

export async function assistantCommentCase(input: {
  threadId: string;
  localCaseId: string;
  body: string;
}): Promise<QaLabCaseComment> {
  const { suiteId, userId } = await suiteIdForAssistantThread(input.threadId);
  return addCaseComment({
    suiteId,
    localCaseId: input.localCaseId,
    body: input.body,
    authorId: userId,
    authorName: ASSISTANT_AUTHOR_NAME,
  });
}

export async function assistantRegenerateCase(input: {
  threadId: string;
  localCaseId: string;
}): Promise<QaLabCaseRegeneration> {
  const { suiteId, userId } = await suiteIdForAssistantThread(input.threadId);
  return regenerateAdoTestCase({ suiteId, localCaseId: input.localCaseId, userId });
}

async function openComments(suiteId: string): Promise<QaLabCaseComment[]> {
  const rows = await db.query.qaCaseComments.findMany({
    where: and(eq(qaCaseComments.suiteId, suiteId), eq(qaCaseComments.status, 'open')),
    orderBy: [asc(qaCaseComments.createdAt)],
  });
  return rows.map((row) => ({
    id: row.id,
    localCaseId: row.localCaseId,
    body: row.body,
    status: row.status,
    authorName: row.authorName,
    createdAt: row.createdAt,
  }));
}

function casesOf(suite: Suite): QaLabAssistantCaseView[] {
  const published = new Set(publishedCasesFrom(suite.publishedCases).map((entry) => entry.localCaseId));
  return listAdoSuiteCases(suite.testCasesJson).map(({ localCaseId, pbiId, testCase }) => ({
    localCaseId,
    pbiId,
    published: published.has(localCaseId),
    testCase,
  }));
}

function renderAssistantContext(input: {
  suite: Suite;
  threadId: string;
  comments: QaLabCaseComment[];
  skillPath: string | null;
  testPlanSection: string[];
}): string {
  const { suite } = input;
  const cases = casesOf(suite);
  return [
    '# QA Lab Assistant Context',
    `qa_suite_id: ${suite.id}`,
    `thread_id: ${input.threadId}`,
    `project: ${suite.project}`,
    `root_work_item: ${suite.rootWorkItemId} ${suite.rootTitle}`,
    '',
    '## How to change cases',
    '',
    'You are Ask Apex inside QA Lab. QA reviews the generated test cases below before they',
    'are published to Azure DevOps. Make changes with these MCP tools, always passing',
    `\`threadId: "${input.threadId}"\`. Do not describe a change without making it.`,
    '',
    '- `qa_lab_get_cases` — the current cases and open comments. Call it before editing when',
    '  earlier turns changed cases, because the list below is from when the chat opened.',
    '- `qa_lab_update_case` — change one case. Pass only the fields that change; `steps`',
    '  replaces every step. QA can see the change and restore the old version.',
    '- `qa_lab_add_case` — add a case to one work item\'s cases.',
    '- `qa_lab_delete_case` — remove one case. Only when QA asks for that exact case.',
    '- `qa_lab_comment_case` — leave a review comment on a case.',
    '- `qa_lab_regenerate_case` — rewrite a case from its open comments with the test-case',
    '  skill. It runs in the background for a few minutes.',
    '',
    'Published cases live in Azure DevOps and cannot be changed here. Publishing is a QA',
    'button, never a tool call.',
    '',
    input.skillPath
      ? `Write every case in this project's format. Read the test-case skill at \`${input.skillPath}\` and the files next to it before you add or rewrite steps.`
      : 'Match the format of the existing cases when you add or rewrite steps.',
    '',
    ...input.testPlanSection,
    '## Cases',
    '',
    '```json',
    JSON.stringify(cases, null, 2),
    '```',
    '',
    ...(input.comments.length > 0
      ? [
        '## Open comments',
        '',
        ...input.comments.map((comment) =>
          `- ${comment.localCaseId}: ${comment.body.replace(/\s+/g, ' ').trim()}${comment.authorName ? ` (${comment.authorName})` : ''}`),
        '',
      ]
      : []),
    '## Work items',
    '',
    '```json',
    JSON.stringify(suite.sourceSnapshot, null, 2),
    '```',
  ].join('\n');
}

async function writeContext(
  workspaceDir: string,
  threadId: string,
  context: string,
  testPlans: Parameters<typeof writeTestPlanFile>[1],
): Promise<void> {
  fs.mkdirSync(path.join(workspaceDir, '.ai-pilot'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.ai-pilot', 'kickoff-context.md'), context, 'utf-8');
  writeTestPlanFile(workspaceDir, testPlans);
  await updateThreadKickoffContext(threadId, context);
}
