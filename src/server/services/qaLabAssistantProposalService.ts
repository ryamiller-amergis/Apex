import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { qaAdoTestSuites, qaCaseComments, qaLabAssistantProposals } from '../db/schema';
import type {
  QaLabAssistantProposal,
  QaLabAssistantProposalKind,
} from '../../shared/types/qaLab';
import {
  AdoTestSuiteConflictError,
  findAdoSuiteCase,
  publishedCasesFrom,
} from './adoTestCaseSuiteService';
import { getThread } from './chatAgentService';
import { loadReadySuite, QaCaseNotFoundError } from './qaCaseRegenerationService';
import {
  applyAddCase,
  applyCommentCase,
  applyDeleteCase,
  applyEditCase,
  applyRegenerateCase,
  prepareAddCase,
  resolveToolSuite,
  QaLabAssistantThreadError,
} from './qaLabAssistantService';
import { normalizeTestCase } from './testCaseLookupService';
import { emitSkillSignalLater, type SkillSignalInput } from './skillSignalService';

const MAX_COMMENT_LENGTH = 4000;
const MAX_REASON_LENGTH = 500;

type ProposalRow = typeof qaLabAssistantProposals.$inferSelect;
type Suite = Awaited<ReturnType<typeof loadReadySuite>>;

export interface ProposalReceipt {
  proposalId: string;
  status: 'pending';
  message: string;
}

const RECEIPT_MESSAGE = 'Shown to QA in the chat with the old and new text. It is applied only when QA confirms.';

/** Kinds that replace an earlier pending proposal for the same case. */
const CASE_CHANGE_KINDS: QaLabAssistantProposalKind[] = ['edit', 'delete', 'regenerate'];

export async function proposeEditCase(input: {
  threadId: string;
  suiteId?: string;
  localCaseId: string;
  patch: Record<string, unknown>;
  reason?: string;
}): Promise<ProposalReceipt> {
  const { suite, userId } = await resolveToolSuite(input.threadId, input.suiteId);
  const before = unpublishedCase(suite, input.localCaseId, 'edited');
  const patch = Object.fromEntries(Object.entries(input.patch).filter(([key]) => key !== 'id'));
  const after: Record<string, unknown> = { ...before, ...patch, id: input.localCaseId };
  if (typeof after.title !== 'string' || after.title.trim().length === 0) {
    throw new AdoTestSuiteConflictError('A case needs a title');
  }
  if (!Array.isArray(after.steps) || after.steps.length === 0) {
    throw new AdoTestSuiteConflictError('A case needs at least one step');
  }
  return saveProposal({
    threadId: input.threadId,
    suiteId: suite.id,
    localCaseId: input.localCaseId,
    kind: 'edit',
    payload: { patch },
    beforeCase: before,
    afterCase: after,
    reason: input.reason,
    userId,
  });
}

export async function proposeAddCase(input: {
  threadId: string;
  suiteId?: string;
  pbiId: string;
  testCase: Record<string, unknown>;
  reason?: string;
}): Promise<ProposalReceipt> {
  const { suite, userId } = await resolveToolSuite(input.threadId, input.suiteId);
  const testCase = Object.fromEntries(Object.entries(input.testCase).filter(([key]) => key !== 'id'));
  const appended = prepareAddCase(suite.testCasesJson, input.pbiId, testCase);
  return saveProposal({
    threadId: input.threadId,
    suiteId: suite.id,
    localCaseId: null,
    kind: 'add',
    payload: { pbiId: input.pbiId, testCase },
    beforeCase: null,
    afterCase: { ...testCase, id: appended.localCaseId },
    reason: input.reason,
    userId,
  });
}

export async function proposeDeleteCase(input: {
  threadId: string;
  suiteId?: string;
  localCaseId: string;
  reason?: string;
}): Promise<ProposalReceipt> {
  const { suite, userId } = await resolveToolSuite(input.threadId, input.suiteId);
  const before = unpublishedCase(suite, input.localCaseId, 'deleted');
  return saveProposal({
    threadId: input.threadId,
    suiteId: suite.id,
    localCaseId: input.localCaseId,
    kind: 'delete',
    payload: {},
    beforeCase: before,
    afterCase: null,
    reason: input.reason,
    userId,
  });
}

export async function proposeCommentCase(input: {
  threadId: string;
  suiteId?: string;
  localCaseId: string;
  body: string;
  reason?: string;
}): Promise<ProposalReceipt> {
  const { suite, userId } = await resolveToolSuite(input.threadId, input.suiteId);
  const match = findAdoSuiteCase(suite.testCasesJson, input.localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${input.localCaseId} is not in this suite`);
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new AdoTestSuiteConflictError(`A comment needs 1 to ${MAX_COMMENT_LENGTH} characters`);
  }
  return saveProposal({
    threadId: input.threadId,
    suiteId: suite.id,
    localCaseId: input.localCaseId,
    kind: 'comment',
    payload: { body },
    beforeCase: match.testCase,
    afterCase: null,
    reason: input.reason,
    userId,
  });
}

export async function proposeRegenerateCase(input: {
  threadId: string;
  suiteId?: string;
  localCaseId: string;
  reason?: string;
}): Promise<ProposalReceipt> {
  const { suite, userId } = await resolveToolSuite(input.threadId, input.suiteId);
  const before = unpublishedCase(suite, input.localCaseId, 'regenerated');
  const [openComment, pendingComment] = await Promise.all([
    db.query.qaCaseComments.findFirst({
      where: and(
        eq(qaCaseComments.suiteId, suite.id),
        eq(qaCaseComments.localCaseId, input.localCaseId),
        eq(qaCaseComments.status, 'open'),
      ),
      columns: { id: true },
    }),
    db.query.qaLabAssistantProposals.findFirst({
      where: and(
        eq(qaLabAssistantProposals.threadId, input.threadId),
        eq(qaLabAssistantProposals.suiteId, suite.id),
        eq(qaLabAssistantProposals.localCaseId, input.localCaseId),
        eq(qaLabAssistantProposals.kind, 'comment'),
        eq(qaLabAssistantProposals.status, 'pending'),
      ),
      columns: { id: true },
    }),
  ]);
  if (!openComment && !pendingComment) {
    throw new AdoTestSuiteConflictError('Propose a comment that says what to change first');
  }
  return saveProposal({
    threadId: input.threadId,
    suiteId: suite.id,
    localCaseId: input.localCaseId,
    kind: 'regenerate',
    payload: {},
    beforeCase: before,
    afterCase: null,
    reason: input.reason,
    userId,
  });
}

/** Pending and failed proposals of the user's thread, oldest first. */
export async function listProposals(threadId: string, userId: string): Promise<QaLabAssistantProposal[]> {
  await requireOwnThread(threadId, userId);
  const rows = await db.query.qaLabAssistantProposals.findMany({
    where: and(
      eq(qaLabAssistantProposals.threadId, threadId),
      inArray(qaLabAssistantProposals.status, ['pending', 'failed']),
    ),
    orderBy: [asc(qaLabAssistantProposals.createdAt)],
  });
  return toProposals(rows);
}

/** Applies one pending or failed proposal; a failure is saved on the proposal and returned. */
export async function confirmProposal(threadId: string, proposalId: string, userId: string): Promise<QaLabAssistantProposal> {
  await requireOwnThread(threadId, userId);
  const row = await findDecidable(threadId, proposalId);
  return (await toProposals([await applyProposal(row, userId)]))[0];
}

export async function discardProposal(threadId: string, proposalId: string, userId: string): Promise<QaLabAssistantProposal> {
  await requireOwnThread(threadId, userId);
  const row = await findDecidable(threadId, proposalId);
  return (await toProposals([await decide(row.id, { status: 'discarded', decidedBy: userId })]))[0];
}

/** Applies every pending proposal in the order Ask Apex made them. */
export async function confirmAllProposals(threadId: string, userId: string): Promise<QaLabAssistantProposal[]> {
  await requireOwnThread(threadId, userId);
  const rows = await pendingRows(threadId);
  const decided: ProposalRow[] = [];
  for (const row of rows) decided.push(await applyProposal(row, userId));
  return toProposals(decided);
}

export async function discardAllProposals(threadId: string, userId: string): Promise<QaLabAssistantProposal[]> {
  await requireOwnThread(threadId, userId);
  const rows = await pendingRows(threadId);
  const decided: ProposalRow[] = [];
  for (const row of rows) decided.push(await decide(row.id, { status: 'discarded', decidedBy: userId }));
  return toProposals(decided);
}

async function applyProposal(row: ProposalRow, userId: string): Promise<ProposalRow> {
  try {
    const suite = await loadReadySuite(row.suiteId);
    if (row.kind !== 'add' && row.kind !== 'comment' && row.localCaseId) {
      const current = findAdoSuiteCase(suite.testCasesJson, row.localCaseId)?.testCase ?? null;
      if (!current || stableJson(current) !== stableJson(row.beforeCase)) {
        throw new AdoTestSuiteConflictError('The case changed after this was proposed. Ask Apex again.');
      }
    }
    const localCaseId = await applyKind(row, userId);
    return decide(row.id, { status: 'applied', decidedBy: userId, error: null, localCaseId });
  } catch (error) {
    const expected = error instanceof AdoTestSuiteConflictError || error instanceof QaCaseNotFoundError;
    if (!expected) console.error(`[qaLabAssistant] Applying proposal ${row.id} failed`, error);
    const message = error instanceof Error ? error.message : 'The change could not be applied';
    return decide(row.id, { status: 'failed', decidedBy: userId, error: message });
  }
}

async function applyKind(row: ProposalRow, userId: string): Promise<string | null> {
  const { suiteId, localCaseId, payload } = row;
  switch (row.kind) {
    case 'edit':
      await applyEditCase({ suiteId, localCaseId: requireCaseId(row), patch: asRecord(payload.patch), userId });
      return localCaseId;
    case 'add':
      return (await applyAddCase({ suiteId, pbiId: String(payload.pbiId ?? ''), testCase: asRecord(payload.testCase) })).localCaseId;
    case 'delete':
      await applyDeleteCase({ suiteId, localCaseId: requireCaseId(row) });
      return localCaseId;
    case 'comment':
      await applyCommentCase({ suiteId, localCaseId: requireCaseId(row), body: String(payload.body ?? ''), userId });
      return localCaseId;
    case 'regenerate':
      await applyRegenerateCase({ suiteId, localCaseId: requireCaseId(row), userId });
      return localCaseId;
    default: {
      const unhandled: never = row.kind;
      throw new Error(`Unhandled proposal kind ${String(unhandled)}`);
    }
  }
}

async function saveProposal(input: {
  threadId: string;
  suiteId: string;
  localCaseId: string | null;
  kind: QaLabAssistantProposalKind;
  payload: Record<string, unknown>;
  beforeCase: Record<string, unknown> | null;
  afterCase: Record<string, unknown> | null;
  reason?: string;
  userId: string;
}): Promise<ProposalReceipt> {
  if (input.localCaseId && CASE_CHANGE_KINDS.includes(input.kind)) {
    await db
      .update(qaLabAssistantProposals)
      .set({ status: 'discarded', decidedAt: new Date().toISOString() })
      .where(and(
        eq(qaLabAssistantProposals.threadId, input.threadId),
        eq(qaLabAssistantProposals.suiteId, input.suiteId),
        eq(qaLabAssistantProposals.localCaseId, input.localCaseId),
        eq(qaLabAssistantProposals.status, 'pending'),
        inArray(qaLabAssistantProposals.kind, CASE_CHANGE_KINDS),
      ));
  }
  const [row] = await db
    .insert(qaLabAssistantProposals)
    .values({
      threadId: input.threadId,
      suiteId: input.suiteId,
      localCaseId: input.localCaseId,
      kind: input.kind,
      payload: input.payload,
      beforeCase: input.beforeCase,
      afterCase: input.afterCase,
      reason: (input.reason ?? '').trim().slice(0, MAX_REASON_LENGTH),
      createdBy: input.userId,
    })
    .returning({ id: qaLabAssistantProposals.id });
  if (!row) throw new Error('Failed to save the proposal');
  return { proposalId: row.id, status: 'pending', message: RECEIPT_MESSAGE };
}

function unpublishedCase(suite: Suite, localCaseId: string, verb: string): Record<string, unknown> {
  const match = findAdoSuiteCase(suite.testCasesJson, localCaseId);
  if (!match) throw new QaCaseNotFoundError(`Case ${localCaseId} is not in this suite`);
  if (publishedCasesFrom(suite.publishedCases).some((entry) => entry.localCaseId === localCaseId)) {
    throw new AdoTestSuiteConflictError(`Published cases cannot be ${verb} here. Change them in Azure DevOps.`);
  }
  return match.testCase;
}

async function requireOwnThread(threadId: string, userId: string): Promise<void> {
  const thread = await getThread(threadId);
  if (!thread || thread.userId !== userId || !thread.kickoff.qaLabSuiteId) {
    throw new QaLabAssistantThreadError('This is not your QA Lab Ask Apex chat');
  }
}

async function findDecidable(threadId: string, proposalId: string): Promise<ProposalRow> {
  const row = await db.query.qaLabAssistantProposals.findFirst({
    where: and(eq(qaLabAssistantProposals.id, proposalId), eq(qaLabAssistantProposals.threadId, threadId)),
  });
  if (!row) throw new QaCaseNotFoundError('Proposal not found');
  if (row.status !== 'pending' && row.status !== 'failed') {
    throw new AdoTestSuiteConflictError(`This change was already ${row.status}`);
  }
  return row;
}

function pendingRows(threadId: string): Promise<ProposalRow[]> {
  return db.query.qaLabAssistantProposals.findMany({
    where: and(eq(qaLabAssistantProposals.threadId, threadId), eq(qaLabAssistantProposals.status, 'pending')),
    orderBy: [asc(qaLabAssistantProposals.createdAt)],
  });
}

async function decide(
  id: string,
  values: Partial<Pick<ProposalRow, 'status' | 'decidedBy' | 'error' | 'localCaseId'>>,
): Promise<ProposalRow> {
  const [row] = await db
    .update(qaLabAssistantProposals)
    .set({ ...values, decidedAt: new Date().toISOString() })
    .where(eq(qaLabAssistantProposals.id, id))
    .returning();
  if (!row) throw new QaCaseNotFoundError('Proposal not found');
  if (row.status === 'applied' || row.status === 'discarded') {
    emitSkillSignalLater(`qa_lab proposal ${row.id}`, () => proposalSignal(row));
  }
  return row;
}

async function proposalSignal(row: ProposalRow): Promise<SkillSignalInput | null> {
  const suite = await db.query.qaAdoTestSuites.findFirst({
    where: eq(qaAdoTestSuites.id, row.suiteId),
    columns: { project: true },
  });
  if (!suite) return null;
  return {
    project: suite.project,
    surface: 'qa_lab',
    subjectType: 'qa_lab_proposal',
    subjectId: row.id,
    threadId: row.threadId,
    kind: row.status === 'applied' ? 'accepted' : 'rejected',
    actorId: row.decidedBy,
    metadata: { proposalKind: row.kind },
  };
}

async function toProposals(rows: ProposalRow[]): Promise<QaLabAssistantProposal[]> {
  const suiteIds = [...new Set(rows.map((row) => row.suiteId))];
  const suites = suiteIds.length === 0
    ? []
    : await db.query.qaAdoTestSuites.findMany({
      where: inArray(qaAdoTestSuites.id, suiteIds),
      columns: { id: true, rootWorkItemId: true, rootTitle: true, testCasesJson: true },
    });
  const byId = new Map(suites.map((suite) => [suite.id, suite]));
  return rows.map((row) => {
    const suite = byId.get(row.suiteId);
    const caseId = row.localCaseId ?? String(row.afterCase?.id ?? '');
    const pbiId = (caseId ? findAdoSuiteCase(suite?.testCasesJson, caseId)?.pbiId : null)
      ?? (typeof row.payload.pbiId === 'string' ? row.payload.pbiId : '');
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      suiteId: row.suiteId,
      workItem: { id: suite?.rootWorkItemId ?? 0, title: suite?.rootTitle ?? '' },
      localCaseId: row.localCaseId,
      reason: row.reason,
      before: row.beforeCase ? normalizeTestCase(row.beforeCase, pbiId, 0) : null,
      after: row.afterCase ? normalizeTestCase(row.afterCase, pbiId, 0) : null,
      commentBody: row.kind === 'comment' && typeof row.payload.body === 'string' ? row.payload.body : null,
      error: row.error,
      createdAt: row.createdAt,
    };
  });
}

function requireCaseId(row: ProposalRow): string {
  if (!row.localCaseId) throw new QaCaseNotFoundError('This proposal has no case');
  return row.localCaseId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** JSON with object keys sorted, so a case read back from jsonb compares equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item));
}
