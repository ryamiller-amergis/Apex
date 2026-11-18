import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseComments, qaCaseRuns, qaLabAssistantProposals } from '../db/schema';
import type {
  QaAdoTestPlanOption,
  QaLabCaseComment,
  QaLabCaseRegeneration,
  QaLabPublishedCase,
} from '../../shared/types/qaLab';
import { getDefaultModel } from './appSettingsService';
import {
  AdoTestSuiteConflictError,
  appendAdoSuiteCase,
  deleteAdoTestCases,
  listAdoSuiteCases,
  publishedCasesFrom,
  readTestPlanOptions,
  renderTestPlanFile,
  renderTestPlanSection,
  summarizeCoverage,
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
import { writeThreadFolderFile } from './threadFolder';

const ASSISTANT_AUTHOR_NAME = 'Ask Apex';
const THREAD_ID_PLACEHOLDER = '__THREAD_ID__';
const MAX_PROJECT_SUITES = 200;

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
  const [comments, cases, otherSuites] = await Promise.all([
    openComments(suite.id),
    casesOf(suite),
    listProjectSuites(suite.project, suite.id),
  ]);
  const render = (threadId: string) => renderAssistantContext({
    suite,
    threadId,
    comments,
    cases,
    otherSuites,
    skillPath: skillConfig?.testCaseSkillPath ?? null,
    testPlanSection: renderInlineTestPlans(testPlans),
  });

  const existing = input.threadId ? await getThread(input.threadId) : null;
  if (
    existing
    && existing.userId === input.userId
    && existing.kickoff.qaLabSuiteId === suite.id
    && existing.workspaceDir
  ) {
    await writeContext(suite.project, existing.workspaceDir, existing.id, render(existing.id));
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
  await writeContext(suite.project, thread.workspaceDir, thread.id, render(thread.id));
  return { threadId: thread.id };
}

/** The suite bound to the calling thread, and who owns the thread. */
export async function suiteIdForAssistantThread(threadId: string): Promise<{ suiteId: string; userId: string }> {
  const thread = await getThread(threadId);
  const suiteId = thread?.kickoff.qaLabSuiteId;
  if (!thread || !suiteId || !thread.userId) {
    throw new QaLabAssistantThreadError('This tool works only in QA Lab Ask Apex');
  }
  return { suiteId, userId: thread.userId };
}

/**
 * The suite a tool call reads or changes: `suiteId` when given, otherwise the thread's
 * own suite. Another suite must be in the same project.
 */
export async function resolveToolSuite(
  threadId: string,
  suiteId?: string,
): Promise<{ suite: Suite; userId: string }> {
  const bound = await suiteIdForAssistantThread(threadId);
  const home = await loadReadySuite(bound.suiteId);
  if (!suiteId || suiteId === home.id) return { suite: home, userId: bound.userId };
  const other = await loadReadySuite(suiteId);
  if (other.project !== home.project) {
    throw new QaLabAssistantThreadError('That suite belongs to another project');
  }
  return { suite: other, userId: bound.userId };
}

export interface QaLabAssistantRunSummary {
  /** The run in progress, if QA has started one. */
  inProgress: { outcome: string | null; stepsPassed: number; stepsFailed: number } | null;
  lastPublished: { outcome: string | null; publishedAt: string | null; runUrl: string | null } | null;
  bugs: Array<{ id: number; title: string; url: string }>;
}

export interface QaLabAssistantCaseView {
  localCaseId: string;
  pbiId: string;
  published: boolean;
  /** Where the case is in Azure DevOps, once published. */
  publish: Pick<QaLabPublishedCase, 'adoTestCaseId' | 'adoTestCaseUrl' | 'testPlanId' | 'testSuiteId' | 'suiteError'> | null;
  run: QaLabAssistantRunSummary | null;
  testCase: Record<string, unknown>;
}

export interface QaLabAssistantSuiteSummary {
  suiteId: string;
  workItem: { id: number; type: string; title: string };
  cases: number;
  published: number;
  updatedAt: string;
}

/** The latest ready suite of every other work item in the thread's project. */
export async function listAssistantSuites(threadId: string): Promise<QaLabAssistantSuiteSummary[]> {
  const { suite } = await resolveToolSuite(threadId);
  return listProjectSuites(suite.project, null);
}

export async function listAssistantCases(threadId: string, suiteId?: string): Promise<{
  suiteId: string;
  rootWorkItemId: number;
  rootTitle: string;
  cases: QaLabAssistantCaseView[];
  openComments: Array<Pick<QaLabCaseComment, 'localCaseId' | 'body' | 'authorName'>>;
  pendingProposals: Array<{ id: string; kind: string; localCaseId: string | null; reason: string }>;
}> {
  const { suite } = await resolveToolSuite(threadId, suiteId);
  const [comments, cases, pending] = await Promise.all([
    openComments(suite.id),
    casesOf(suite),
    db.query.qaLabAssistantProposals.findMany({
      where: and(
        eq(qaLabAssistantProposals.threadId, threadId),
        eq(qaLabAssistantProposals.suiteId, suite.id),
        eq(qaLabAssistantProposals.status, 'pending'),
      ),
      orderBy: [asc(qaLabAssistantProposals.createdAt)],
    }),
  ]);
  return {
    suiteId: suite.id,
    rootWorkItemId: suite.rootWorkItemId,
    rootTitle: suite.rootTitle,
    cases,
    openComments: comments.map(({ localCaseId, body, authorName }) => ({ localCaseId, body, authorName })),
    pendingProposals: pending.map(({ id, kind, localCaseId, reason }) => ({ id, kind, localCaseId, reason })),
  };
}

// The apply functions below run only when QA confirms a proposal.

export function applyEditCase(input: {
  suiteId: string;
  localCaseId: string;
  patch: Record<string, unknown>;
  userId: string;
}): Promise<QaLabCaseRegeneration> {
  return editAdoTestCase(input);
}

export async function applyAddCase(input: {
  suiteId: string;
  pbiId: string;
  testCase: Record<string, unknown>;
}): Promise<{ localCaseId: string }> {
  const suite = await loadReadySuite(input.suiteId);
  const appended = prepareAddCase(suite.testCasesJson, input.pbiId, input.testCase);
  await db
    .update(qaAdoTestSuites)
    .set({
      testCasesJson: appended.testCasesJson,
      coverageSummary: summarizeCoverage(appended.testCasesJson),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(qaAdoTestSuites.id, input.suiteId), eq(qaAdoTestSuites.status, 'ready')));
  return { localCaseId: appended.localCaseId };
}

/** Checks a new case and returns the suite JSON with it appended. */
export function prepareAddCase(
  testCasesJson: unknown,
  pbiId: string,
  testCase: Record<string, unknown>,
): { testCasesJson: Record<string, unknown>; localCaseId: string } {
  const { title, steps } = testCase;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new AdoTestSuiteConflictError('A case needs a title');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AdoTestSuiteConflictError('A case needs at least one step');
  }
  const appended = appendAdoSuiteCase(testCasesJson, pbiId, testCase);
  if (!appended) throw new QaCaseNotFoundError(`No cases in this suite belong to ${pbiId}`);
  return appended;
}

export async function applyDeleteCase(input: { suiteId: string; localCaseId: string }): Promise<{ deleted: boolean }> {
  const { deletedLocalCaseIds } = await deleteAdoTestCases(input.suiteId, [input.localCaseId]);
  return { deleted: deletedLocalCaseIds.includes(input.localCaseId) };
}

export function applyCommentCase(input: {
  suiteId: string;
  localCaseId: string;
  body: string;
  userId: string;
}): Promise<QaLabCaseComment> {
  return addCaseComment({
    suiteId: input.suiteId,
    localCaseId: input.localCaseId,
    body: input.body,
    authorId: input.userId,
    authorName: ASSISTANT_AUTHOR_NAME,
  });
}

export function applyRegenerateCase(input: {
  suiteId: string;
  localCaseId: string;
  userId: string;
}): Promise<QaLabCaseRegeneration> {
  return regenerateAdoTestCase(input);
}

export async function openComments(suiteId: string): Promise<QaLabCaseComment[]> {
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

async function listProjectSuites(project: string, excludeSuiteId: string | null): Promise<QaLabAssistantSuiteSummary[]> {
  const rows = await db.query.qaAdoTestSuites.findMany({
    where: and(eq(qaAdoTestSuites.project, project), eq(qaAdoTestSuites.status, 'ready')),
    columns: {
      id: true,
      rootWorkItemId: true,
      rootWorkItemType: true,
      rootTitle: true,
      testCasesJson: true,
      publishedCases: true,
      updatedAt: true,
    },
    orderBy: [desc(qaAdoTestSuites.createdAt)],
    limit: MAX_PROJECT_SUITES,
  });
  const seen = new Set<number>();
  const suites: QaLabAssistantSuiteSummary[] = [];
  for (const row of rows) {
    if (seen.has(row.rootWorkItemId)) continue;
    seen.add(row.rootWorkItemId);
    if (row.id === excludeSuiteId) continue;
    suites.push({
      suiteId: row.id,
      workItem: { id: row.rootWorkItemId, type: row.rootWorkItemType, title: row.rootTitle },
      cases: listAdoSuiteCases(row.testCasesJson).length,
      published: publishedCasesFrom(row.publishedCases).length,
      updatedAt: row.updatedAt,
    });
  }
  return suites;
}

async function casesOf(suite: Suite): Promise<QaLabAssistantCaseView[]> {
  const ledger = new Map(publishedCasesFrom(suite.publishedCases).map((entry) => [entry.localCaseId, entry]));
  const runs = await runSummaries(suite.id);
  return listAdoSuiteCases(suite.testCasesJson).map(({ localCaseId, pbiId, testCase }) => {
    const entry = ledger.get(localCaseId);
    return {
      localCaseId,
      pbiId,
      published: entry !== undefined,
      publish: entry
        ? {
          adoTestCaseId: entry.adoTestCaseId,
          adoTestCaseUrl: entry.adoTestCaseUrl,
          ...(entry.testPlanId !== undefined ? { testPlanId: entry.testPlanId } : {}),
          ...(entry.testSuiteId !== undefined ? { testSuiteId: entry.testSuiteId } : {}),
          ...(entry.suiteError ? { suiteError: entry.suiteError } : {}),
        }
        : null,
      run: runs.get(localCaseId) ?? null,
      testCase,
    };
  });
}

async function runSummaries(suiteId: string): Promise<Map<string, QaLabAssistantRunSummary>> {
  const rows = await db.query.qaCaseRuns.findMany({
    where: eq(qaCaseRuns.suiteId, suiteId),
    orderBy: [desc(qaCaseRuns.createdAt)],
  });
  const summaries = new Map<string, QaLabAssistantRunSummary>();
  for (const row of rows) {
    const summary = summaries.get(row.localCaseId) ?? { inProgress: null, lastPublished: null, bugs: [] };
    if (row.status === 'draft') {
      summary.inProgress = {
        outcome: row.outcome,
        stepsPassed: row.stepResults.filter((step) => step.outcome === 'passed').length,
        stepsFailed: row.stepResults.filter((step) => step.outcome === 'failed').length,
      };
    } else if (!summary.lastPublished) {
      summary.lastPublished = { outcome: row.outcome, publishedAt: row.publishedAt, runUrl: row.adoRunUrl };
    }
    summary.bugs.push(...row.bugs.map(({ id, title, url }) => ({ id, title, url })));
    summaries.set(row.localCaseId, summary);
  }
  return summaries;
}

const HOW_QA_LAB_WORKS = [
  '## How QA Lab works',
  '',
  'Use this to answer "how do I…" questions. QA does these steps with buttons; you never do them.',
  '',
  '1. **Generate.** QA picks an Azure DevOps work item. Apex runs the project test-case skill on',
  '   it and its PBIs and saves the cases as a suite (one suite per work item, newest wins).',
  '2. **Review.** QA reads each case, comments on it, and regenerates it from the comments, or',
  '   asks you to change it. A changed case shows what changed and can be restored.',
  '3. **Run.** "Run this test" on a case records Pass/Fail, comments and files for each step and',
  '   for the whole case. Results stay in Apex until publish. When something fails and a comment',
  '   explains it, Create Bug files a Bug in Azure DevOps under the PBI right away.',
  '4. **Publish.** QA chooses a Test Plan and suite and publishes. Apex creates the Test Cases',
  '   under the project area path, then sends each run that has a result as a test run, and links',
  '   any Bugs to the Test Case and the result. Published cases are changed in Azure DevOps, not',
  '   here.',
  '',
];

function renderAssistantContext(input: {
  suite: Suite;
  threadId: string;
  comments: QaLabCaseComment[];
  cases: QaLabAssistantCaseView[];
  otherSuites: QaLabAssistantSuiteSummary[];
  skillPath: string | null;
  testPlanSection: string[];
}): string {
  const { suite } = input;
  return [
    '# QA Lab Assistant Context',
    `qa_suite_id: ${suite.id}`,
    `thread_id: ${input.threadId}`,
    `project: ${suite.project}`,
    `root_work_item: ${suite.rootWorkItemId} ${suite.rootTitle}`,
    '',
    '## How to change cases',
    '',
    'You are Ask Apex inside QA Lab. QA reviews generated test cases before they are published',
    `to Azure DevOps. Use these MCP tools, always passing \`threadId: "${input.threadId}"\`.`,
    '',
    'Every change you make is a proposal. QA sees the old and new text in the chat and confirms',
    'or discards it; nothing changes until QA confirms. So say the change is ready for review,',
    'never that it is done. Give each proposal a short `reason`. One proposal per case: a new',
    'edit of the same case replaces your earlier one.',
    '',
    'Pass `suiteId` to work on another work item\'s suite (listed below); leave it out for this one.',
    '',
    '- `qa_lab_list_suites` — every work item in this project\'s QA Lab, with its suiteId.',
    '- `qa_lab_get_cases` — a suite\'s current cases, publish status, run results, Bugs, open',
    '  comments and your pending proposals. Call it before proposing when earlier turns changed',
    '  cases, because the lists below are from when the chat opened.',
    '- `qa_lab_update_case` — propose a change to one case. Pass only the fields that change;',
    '  `steps` replaces every step.',
    '- `qa_lab_add_case` — propose a new case for one work item.',
    '- `qa_lab_delete_case` — propose removing one case. Only when QA asks for that exact case.',
    '- `qa_lab_comment_case` — propose a review comment on a case.',
    '- `qa_lab_regenerate_case` — propose rewriting a case from its open comments with the',
    '  test-case skill. It runs in the background for a few minutes once confirmed.',
    '',
    'Published cases live in Azure DevOps and cannot be changed here. Running tests, filing Bugs',
    'and publishing are QA buttons, never tool calls.',
    '',
    input.skillPath
      ? `Write every case in this project's format. Read the test-case skill at \`${input.skillPath}\` and the files next to it before you add or rewrite steps.`
      : 'Match the format of the existing cases when you add or rewrite steps.',
    '',
    ...HOW_QA_LAB_WORKS,
    ...input.testPlanSection,
    '## Cases',
    '',
    'Each case has its publish status (`publish`), its test runs (`run`: the run in progress,',
    'the last published run, and Bugs filed), and the case itself (`testCase`).',
    '',
    '```json',
    JSON.stringify(input.cases, null, 2),
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
    '## Other work items in QA Lab',
    '',
    ...(input.otherSuites.length > 0
      ? input.otherSuites.map((other) =>
        `- ${other.workItem.type} ${other.workItem.id} ${other.workItem.title}: ${other.cases} cases, ${other.published} published (suiteId: ${other.suiteId})`)
      : ['None yet.']),
    '',
    '## Work items',
    '',
    '```json',
    JSON.stringify(suite.sourceSnapshot, null, 2),
    '```',
  ].join('\n');
}

/**
 * The V2 chat host gets the kickoff context but no other `.ai-pilot` files, so
 * the Test Plan list goes in the context too.
 */
function renderInlineTestPlans(testPlans: QaAdoTestPlanOption[]): string[] {
  const [file] = renderTestPlanFile(testPlans);
  if (!file) return [];
  return [
    ...renderTestPlanSection(testPlans),
    `\`${file.path}\` is not on disk for this session; its content is:`,
    '',
    '```markdown',
    file.content.trimEnd(),
    '```',
    '',
  ];
}

async function writeContext(
  project: string,
  workspaceDir: string,
  threadId: string,
  context: string,
): Promise<void> {
  await writeThreadFolderFile({ project, workspaceDir, relativePath: '.ai-pilot/kickoff-context.md', content: context });
  await updateThreadKickoffContext(threadId, context);
}
