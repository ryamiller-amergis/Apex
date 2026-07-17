import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { adrs, appUsers, reviewComments } from '../db/schema';
import type { Adr, AdrStatus, AdrSummary } from '../../shared/types/adr';
import { markAsInterviewThread, readOutputAdr } from './chatAgentService';
import { getSkillSettingsName } from './projectSettingsService';
import { assignApprovers, isApprovalComplete } from './documentApprovalService';
import { getUnresolvedCount } from './reviewCommentService';
import { recordOwnerApproval } from './ownerApprovalService';
import { listGroupsWithMembers } from './groupService';

const EDITABLE_STATUSES: AdrStatus[] = ['in_progress', 'accepted', 'superseded'];
const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 360;
const activeAdrWatchers = new Map<string, ReturnType<typeof setInterval>>();

function httpError(message: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function mapStatus(value: string): AdrStatus {
  return ['in_progress', 'generating', 'proposed', 'accepted', 'superseded'].includes(value)
    ? value as AdrStatus
    : 'proposed';
}

function parseFrontmatter(content: string): { status: AdrStatus; slug: string | null } {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const block = frontmatter?.[1] ?? '';
  const statusValue = block.match(/^status:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  const slug = block.match(/^slug:\s*(.+)$/im)?.[1]?.trim() ?? null;
  const status = statusValue === 'accepted'
    ? 'accepted'
    : statusValue === 'superseded'
      ? 'superseded'
      : 'proposed';
  return { status, slug };
}

function forceProposedStatus(content: string): string {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return content;
  const block = frontmatter[1];
  const nextBlock = /^status:\s*.+$/im.test(block)
    ? block.replace(/^status:\s*.+$/im, 'status: Proposed')
    : `${block}\nstatus: Proposed`;
  return content.replace(frontmatter[0], `---\n${nextBlock}\n---`);
}

function setAdrLifecycleStatus(content: string, status: 'Accepted' | 'Superseded'): string {
  if (!content.trim()) return content;
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  let nextContent: string;
  if (frontmatter) {
    const block = frontmatter[1];
    const nextBlock = /^status:\s*.+$/im.test(block)
      ? block.replace(/^status:\s*.+$/im, `status: ${status}`)
      : `${block}\nstatus: ${status}`;
    nextContent = content.replace(frontmatter[0], `---\n${nextBlock}\n---`);
  } else if (/^status:\s*.+$/im.test(content)) {
    nextContent = content.replace(/^status:\s*.+$/im, `status: ${status}`);
  } else {
    nextContent = `---\nstatus: ${status}\n---\n\n${content}`;
  }
  return nextContent.replace(
    /(^##[ \t]+Status[ \t]*\r?\n(?:[ \t]*\r?\n)*)([^\r\n]+)/im,
    `$1${status}`,
  );
}

async function withSettingsName(
  row: typeof adrs.$inferSelect,
): Promise<Adr> {
  const reviewerIds = row.reviewerIds ?? [];
  const userIds = [...new Set([row.authorId, ...reviewerIds])];
  const users = userIds.length > 0
    ? await db
      .select({ id: appUsers.oid, displayName: appUsers.displayName })
      .from(appUsers)
      .where(inArray(appUsers.oid, userIds))
    : [];
  const displayNameById = new Map(users.map((user) => [user.id, user.displayName ?? user.id]));
  return {
    ...row,
    ownerName: displayNameById.get(row.authorId) ?? row.authorId,
    reviewerIds,
    reviewers: reviewerIds.map((id) => ({
      id,
      displayName: displayNameById.get(id) ?? id,
    })),
    model: row.model ?? undefined,
    skillSettingsId: row.skillSettingsId ?? null,
    skillSettingsName: await getSkillSettingsName(row.skillSettingsId),
    status: mapStatus(row.status),
    slug: row.slug ?? null,
    fixCommentId: row.fixCommentId ?? null,
  };
}

export async function createAdr(opts: {
  userId: string;
  project: string;
  repo: string;
  title: string;
  chatThreadId: string;
  model?: string;
  skillSettingsId?: string | null;
  reviewerIds?: string[];
}): Promise<{ adrId: string; threadId: string }> {
  const reviewerIds = [...new Set(opts.reviewerIds ?? [])];
  if (reviewerIds.includes(opts.userId)) {
    throw httpError('The ADR owner cannot also be assigned as a reviewer', 400);
  }
  if (reviewerIds.length > 0) {
    const groups = await listGroupsWithMembers(opts.project);
    const developerIds = new Set(
      groups.find((group) => group.name === 'Developer')?.members.map((member) => member.userId) ?? [],
    );
    const invalidReviewerIds = reviewerIds.filter((id) => !developerIds.has(id));
    if (invalidReviewerIds.length > 0) {
      throw httpError(`ADR reviewers must belong to the Developer group: ${invalidReviewerIds.join(', ')}`, 400);
    }
  }
  const [row] = await db.insert(adrs).values({
    chatThreadId: opts.chatThreadId,
    authorId: opts.userId,
    reviewerIds,
    title: opts.title,
    project: opts.project,
    repo: opts.repo,
    model: opts.model ?? null,
    skillSettingsId: opts.skillSettingsId ?? null,
    status: 'in_progress',
  }).returning({ id: adrs.id });

  if (reviewerIds.length > 0) {
    await assignApprovers(row.id, 'adr', reviewerIds, opts.userId);
  }
  markAsInterviewThread(opts.chatThreadId);
  return { adrId: row.id, threadId: opts.chatThreadId };
}

export async function listAdrs(filters?: {
  status?: AdrStatus;
  project?: string;
  authorId?: string;
}): Promise<AdrSummary[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.status) conditions.push(eq(adrs.status, filters.status));
  if (filters?.project) conditions.push(eq(adrs.project, filters.project));
  if (filters?.authorId) conditions.push(eq(adrs.authorId, filters.authorId));

  const rows = await db.select().from(adrs)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(adrs.updatedAt));

  return Promise.all(rows.map(async (row) => {
    const { content: _content, ...summary } = await withSettingsName(row);
    return summary;
  }));
}

export async function getAdr(id: string): Promise<Adr | null> {
  const row = await db.query.adrs.findFirst({
    where: eq(adrs.id, id),
  });
  return row ? withSettingsName(row) : null;
}

async function requireAuthor(id: string, userId: string): Promise<typeof adrs.$inferSelect> {
  const row = await db.query.adrs.findFirst({ where: eq(adrs.id, id) });
  if (!row) throw httpError('ADR not found', 404);
  if (row.authorId !== userId) throw httpError('Only the author can modify this ADR', 403);
  return row;
}

export async function updateAdrStatus(id: string, userId: string, status: AdrStatus): Promise<void> {
  if (!EDITABLE_STATUSES.includes(status)) throw httpError(`Invalid ADR status: ${status}`, 400);
  const row = await requireAuthor(id, userId);
  if (status === 'accepted' && row.proposedContent != null) {
    throw httpError('Apply or reject the proposed ADR edits before accepting the ADR', 409);
  }
  if (status === 'accepted') {
    const unresolvedCount = await getUnresolvedCount(id, 'adr');
    if (unresolvedCount > 0) {
      throw httpError('Resolve all review comments before accepting the ADR', 409);
    }
    const { complete } = await isApprovalComplete(id, 'adr', row.project);
    if (!complete) {
      throw httpError('Reviewers must approve the ADR before the owner can give final approval', 409);
    }
    await recordOwnerApproval(id, 'adr', userId, 'approved');
  }
  const content = status === 'accepted'
    ? setAdrLifecycleStatus(row.content, 'Accepted')
    : status === 'superseded'
      ? setAdrLifecycleStatus(row.content, 'Superseded')
      : row.content;
  await db.update(adrs).set({
    status,
    content,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export async function updateAdrTitle(id: string, userId: string, title: string): Promise<void> {
  await requireAuthor(id, userId);
  await db.update(adrs).set({ title, updatedAt: new Date().toISOString() }).where(eq(adrs.id, id));
}

export async function setAdrAssistantThread(id: string, userId: string, threadId: string): Promise<void> {
  const row = await requireAuthor(id, userId);
  if (row.status !== 'proposed') throw httpError('ADR Assistant is available only for proposed ADRs', 409);
  await db.update(adrs).set({
    adrAssistantThreadId: threadId,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export async function stageAdrProposedContent(
  id: string,
  userId: string,
  threadId: string,
  content: string,
): Promise<void> {
  const row = await requireAuthor(id, userId);
  if (row.status !== 'proposed') throw httpError('ADR edits can be proposed only while the ADR is proposed', 409);
  if (row.adrAssistantThreadId !== threadId) throw httpError('Thread is not linked to this ADR assistant', 403);
  await db.update(adrs).set({
    proposedContent: forceProposedStatus(content),
    fixCommentId: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export async function stageAdrReviewFix(
  id: string,
  userId: string,
  content: string,
  fixCommentId: string | null,
): Promise<void> {
  const row = await requireAuthor(id, userId);
  if (row.status !== 'proposed') throw httpError('ADR review fixes are available only while the ADR is proposed', 409);
  await db.update(adrs).set({
    proposedContent: forceProposedStatus(content),
    fixCommentId,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export async function applyAdrProposedContent(id: string, userId: string): Promise<void> {
  const row = await requireAuthor(id, userId);
  if (row.status !== 'proposed') throw httpError('Proposed edits can be applied only while the ADR is proposed', 409);
  if (row.proposedContent == null) throw httpError('No proposed ADR edits to apply', 409);
  const content = forceProposedStatus(row.proposedContent);
  const metadata = parseFrontmatter(content);
  const now = new Date().toISOString();
  await db.update(adrs).set({
    content,
    slug: metadata.slug,
    status: 'proposed',
    proposedContent: null,
    fixCommentId: null,
    updatedAt: now,
  }).where(eq(adrs.id, id));
  const commentFilter = row.fixCommentId
    ? and(
      eq(reviewComments.id, row.fixCommentId),
      eq(reviewComments.documentId, id),
      eq(reviewComments.documentType, 'adr'),
      eq(reviewComments.status, 'open'),
    )
    : and(
      eq(reviewComments.documentId, id),
      eq(reviewComments.documentType, 'adr'),
      eq(reviewComments.status, 'open'),
    );
  await db.update(reviewComments).set({
    status: 'resolved',
    resolvedBy: userId,
    resolvedAt: now,
    updatedAt: now,
  }).where(commentFilter);
}

export async function rejectAdrProposedContent(id: string, userId: string): Promise<void> {
  const row = await requireAuthor(id, userId);
  if (row.status !== 'proposed') throw httpError('Proposed edits can be rejected only while the ADR is proposed', 409);
  await db.update(adrs).set({
    proposedContent: null,
    fixCommentId: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export async function deleteAdr(id: string, userId: string): Promise<void> {
  await requireAuthor(id, userId);
  await db.delete(adrs).where(eq(adrs.id, id));
}

export async function markAdrGenerating(id: string, userId: string): Promise<void> {
  await requireAuthor(id, userId);
  await db.update(adrs).set({ status: 'generating', updatedAt: new Date().toISOString() }).where(eq(adrs.id, id));
}

export async function syncAdrContent(id: string, content: string): Promise<void> {
  const metadata = parseFrontmatter(content);
  await db.update(adrs).set({
    content,
    status: metadata.status,
    slug: metadata.slug,
    updatedAt: new Date().toISOString(),
  }).where(eq(adrs.id, id));
}

export function startAdrWatcher(adrId: string, generationThreadId: string): void {
  const existing = activeAdrWatchers.get(adrId);
  if (existing) clearInterval(existing);
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts += 1;
    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeAdrWatchers.delete(adrId);
      await db.update(adrs)
        .set({ status: 'in_progress', updatedAt: new Date().toISOString() })
        .where(and(eq(adrs.id, adrId), eq(adrs.status, 'generating')));
      return;
    }

    const content = readOutputAdr(generationThreadId);
    if (!content) return;
    clearInterval(interval);
    activeAdrWatchers.delete(adrId);
    try {
      await syncAdrContent(adrId, content);
    } catch (error) {
      console.error(`[adrWatcher] Failed to sync ADR ${adrId}:`, error);
    }
  }, WATCHER_INTERVAL_MS);

  activeAdrWatchers.set(adrId, interval);
}
