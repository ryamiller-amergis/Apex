import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/drizzle';
import {
  adrs,
  appPermissions,
  appRolePermissions,
  appUserRoles,
  appUsers,
  featureRequestAdrs,
  featureRequests,
  userProjectAssignments,
} from '../db/schema';
import type {
  FeatureRequest,
  FeatureRequestAiStatus,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
  LinkedAdrSummary,
  WorkItemType,
  UpdateFeatureRequestDTO,
} from '../../shared/types/featureRequest';
import { APEX_ASSIGNEE_ID } from '../../shared/types/apexWorkItem';
import { createNotification } from './notificationService';
import {
  APEX_OWNER,
  assertEligibleHumanAssignee,
  listProjectAssignees,
} from './projectAssigneeService';
import { generateFeatureRequestRankings } from './featureRequestRankingService';
import { getSuperAdminEmails } from '../utils/superAdmin';

const featureRequestAssignee = alias(appUsers, 'feature_request_assignee');

// ── Row → shared type mapper ──────────────────────────────────────────────────

interface FeatureRequestRow {
  id: string;
  type: string;
  title: string;
  request: string;
  advantage: string | null;
  interviewId: string | null;
  submittedBy: string;
  sourceProject: string;
  assignedToOid: string | null;
  assignedToApex: boolean;
  status: string;
  aiStatus: string;
  aiPriority: string | null;
  aiRisk: string | null;
  aiRationale: string | null;
  aiThreadId: string | null;
  teamPriority: string | null;
  teamRisk: string | null;
  rank: number | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
  submitterName?: string | null;
  assigneeName?: string | null;
  assigneeEmail?: string | null;
}

function toFeatureRequest(row: FeatureRequestRow, linkedAdrs: LinkedAdrSummary[] = []): FeatureRequest {
  return {
    id: row.id,
    type: row.type as WorkItemType,
    title: row.title,
    request: row.request,
    advantage: row.advantage,
    interviewId: row.interviewId,
    submittedBy: row.submittedBy,
    sourceProject: row.sourceProject,
    assignedTo: row.assignedToApex
      ? APEX_OWNER
      : row.assignedToOid
        ? {
            oid: row.assignedToOid,
            displayName:
              row.assigneeName ?? row.assigneeEmail ?? row.assignedToOid,
            email: row.assigneeEmail ?? '',
          }
        : null,
    assignedToApex: row.assignedToApex,
    status: row.status as FeatureRequestStatus,
    aiStatus: row.aiStatus as FeatureRequestAiStatus,
    aiPriority: row.aiPriority as FeatureRequestPriority | null,
    aiRisk: row.aiRisk as FeatureRequestRisk | null,
    aiRationale: row.aiRationale,
    aiThreadId: row.aiThreadId,
    teamPriority: row.teamPriority as FeatureRequestPriority | null,
    teamRisk: row.teamRisk as FeatureRequestRisk | null,
    rank: row.rank,
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submitterName: row.submitterName ?? undefined,
    linkedAdrs,
  };
}

function httpError(message: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadLinkedAdrs(requestIds: string[]): Promise<Map<string, LinkedAdrSummary[]>> {
  const result = new Map<string, LinkedAdrSummary[]>();
  if (requestIds.length === 0) return result;
  const rows = await db
    .select({
      featureRequestId: featureRequestAdrs.featureRequestId,
      id: adrs.id,
      title: adrs.title,
      project: adrs.project,
      repo: adrs.repo,
      slug: adrs.slug,
      status: adrs.status,
    })
    .from(featureRequestAdrs)
    .innerJoin(adrs, eq(featureRequestAdrs.adrId, adrs.id))
    .where(inArray(featureRequestAdrs.featureRequestId, requestIds));
  for (const row of rows) {
    const linked = result.get(row.featureRequestId) ?? [];
    linked.push({
      id: row.id,
      title: row.title,
      project: row.project,
      repo: row.repo,
      slug: row.slug,
      status: 'accepted',
    });
    result.set(row.featureRequestId, linked);
  }
  return result;
}

// ── createFeatureRequest ──────────────────────────────────────────────────────

export async function createFeatureRequest(
  userId: string,
  project: string,
  data: { type: WorkItemType; title: string; request: string; advantage?: string | null; adrIds?: string[] },
): Promise<FeatureRequest> {
  const adrIds = [...new Set(data.adrIds ?? [])];
  if (adrIds.some((id) => !UUID_PATTERN.test(id))) {
    throw httpError('adrIds must contain valid UUIDs', 400);
  }
  if (data.type === 'issue' && adrIds.length > 0) {
    throw httpError('ADRs can only be linked to feature or technical requests', 400);
  }
  if (adrIds.length > 0) {
    return db.transaction(async (tx) => {
      const linkedRows = await tx
        .select({
          id: adrs.id,
          title: adrs.title,
          project: adrs.project,
          repo: adrs.repo,
          slug: adrs.slug,
          status: adrs.status,
        })
        .from(adrs)
        .where(and(
          inArray(adrs.id, adrIds),
          eq(adrs.status, 'accepted'),
          eq(adrs.project, project),
        ));
      if (linkedRows.length !== adrIds.length) {
        throw httpError('Every linked ADR must exist, be accepted, and belong to the request project', 400);
      }
      const [row] = await tx.insert(featureRequests).values({
        type: data.type,
        title: data.title,
        request: data.request,
        advantage: data.advantage ?? null,
        submittedBy: userId,
        sourceProject: project,
        status: 'new',
        aiStatus: 'pending',
      }).returning();
      await tx.insert(featureRequestAdrs).values(
        adrIds.map((adrId) => ({ featureRequestId: row.id, adrId })),
      );
      return toFeatureRequest(row, linkedRows.map((adr) => ({
        id: adr.id,
        title: adr.title,
        project: adr.project,
        repo: adr.repo,
        slug: adr.slug,
        status: 'accepted',
      })));
    });
  }
  const [row] = await db
    .insert(featureRequests)
    .values({
      type: data.type,
      title: data.title,
      request: data.request,
      advantage: data.advantage ?? null,
      submittedBy: userId,
      sourceProject: project,
      status: 'new',
      aiStatus: 'pending',
    })
    .returning();

  return toFeatureRequest(row);
}

// ── listFeatureRequests ───────────────────────────────────────────────────────

export async function listFeatureRequests(project: string): Promise<FeatureRequest[]> {
  const rows = await db
    .select({
      id: featureRequests.id,
      type: featureRequests.type,
      title: featureRequests.title,
      request: featureRequests.request,
      advantage: featureRequests.advantage,
      interviewId: featureRequests.interviewId,
      submittedBy: featureRequests.submittedBy,
      sourceProject: featureRequests.sourceProject,
      assignedToOid: featureRequests.assignedToOid,
      assignedToApex: featureRequests.assignedToApex,
      status: featureRequests.status,
      aiStatus: featureRequests.aiStatus,
      aiPriority: featureRequests.aiPriority,
      aiRisk: featureRequests.aiRisk,
      aiRationale: featureRequests.aiRationale,
      aiThreadId: featureRequests.aiThreadId,
      teamPriority: featureRequests.teamPriority,
      teamRisk: featureRequests.teamRisk,
      rank: featureRequests.rank,
      reviewedBy: featureRequests.reviewedBy,
      createdAt: featureRequests.createdAt,
      updatedAt: featureRequests.updatedAt,
      submitterName: appUsers.displayName,
      assigneeName: featureRequestAssignee.displayName,
      assigneeEmail: featureRequestAssignee.email,
    })
    .from(featureRequests)
    .leftJoin(appUsers, eq(featureRequests.submittedBy, appUsers.oid))
    .leftJoin(
      featureRequestAssignee,
      eq(featureRequests.assignedToOid, featureRequestAssignee.oid),
    )
    .where(eq(featureRequests.sourceProject, project))
    .orderBy(sql`${featureRequests.rank} NULLS LAST`, desc(featureRequests.createdAt));

  const linksByRequest = await loadLinkedAdrs(rows.map((row) => row.id));
  return rows.map((row) => toFeatureRequest(row, linksByRequest.get(row.id) ?? []));
}

// ── getFeatureRequest ─────────────────────────────────────────────────────────

export async function getFeatureRequest(id: string): Promise<FeatureRequest | null> {
  const rows = await db
    .select({
      id: featureRequests.id,
      type: featureRequests.type,
      title: featureRequests.title,
      request: featureRequests.request,
      advantage: featureRequests.advantage,
      interviewId: featureRequests.interviewId,
      submittedBy: featureRequests.submittedBy,
      sourceProject: featureRequests.sourceProject,
      assignedToOid: featureRequests.assignedToOid,
      assignedToApex: featureRequests.assignedToApex,
      status: featureRequests.status,
      aiStatus: featureRequests.aiStatus,
      aiPriority: featureRequests.aiPriority,
      aiRisk: featureRequests.aiRisk,
      aiRationale: featureRequests.aiRationale,
      aiThreadId: featureRequests.aiThreadId,
      teamPriority: featureRequests.teamPriority,
      teamRisk: featureRequests.teamRisk,
      rank: featureRequests.rank,
      reviewedBy: featureRequests.reviewedBy,
      createdAt: featureRequests.createdAt,
      updatedAt: featureRequests.updatedAt,
      submitterName: appUsers.displayName,
      assigneeName: featureRequestAssignee.displayName,
      assigneeEmail: featureRequestAssignee.email,
    })
    .from(featureRequests)
    .leftJoin(appUsers, eq(featureRequests.submittedBy, appUsers.oid))
    .leftJoin(
      featureRequestAssignee,
      eq(featureRequests.assignedToOid, featureRequestAssignee.oid),
    )
    .where(eq(featureRequests.id, id));

  if (rows.length === 0) return null;
  const linksByRequest = await loadLinkedAdrs([rows[0].id]);
  return toFeatureRequest(rows[0], linksByRequest.get(rows[0].id) ?? []);
}

export async function listAcceptedAdrsForProject(project: string): Promise<LinkedAdrSummary[]> {
  const rows = await db
    .select({
      id: adrs.id,
      title: adrs.title,
      project: adrs.project,
      repo: adrs.repo,
      slug: adrs.slug,
    })
    .from(adrs)
    .where(and(eq(adrs.project, project), eq(adrs.status, 'accepted')))
    .orderBy(desc(adrs.updatedAt));
  return rows.map((row) => ({ ...row, status: 'accepted' }));
}

// ── updateFeatureRequest ──────────────────────────────────────────────────────

export async function updateFeatureRequest(
  id: string,
  userId: string,
  patch: UpdateFeatureRequestDTO,
): Promise<FeatureRequest> {
  const existing = await db.query.featureRequests.findFirst({
    where: eq(featureRequests.id, id),
  });
  if (!existing) throw httpError('Feature request not found', 404);

  const set: Record<string, unknown> = {
    reviewedBy: userId,
    updatedAt: new Date().toISOString(),
  };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.teamPriority !== undefined) set.teamPriority = patch.teamPriority;
  if (patch.teamRisk !== undefined) set.teamRisk = patch.teamRisk;
  if (patch.rank !== undefined) set.rank = patch.rank;
  if (patch.assigneeId !== undefined) {
    const assignedToApex = patch.assigneeId === APEX_ASSIGNEE_ID;
    if (patch.assigneeId && !assignedToApex) {
      await assertEligibleHumanAssignee(
        existing.sourceProject,
        patch.assigneeId,
      );
    }
    set.assignedToOid =
      patch.assigneeId && !assignedToApex ? patch.assigneeId : null;
    set.assignedToApex = assignedToApex;
  }

  const [row] = await db
    .update(featureRequests)
    .set(set)
    .where(eq(featureRequests.id, id))
    .returning();

  const assigneeChanged =
    patch.assigneeId !== undefined &&
    (patch.assigneeId === APEX_ASSIGNEE_ID
      ? !existing.assignedToApex
      : patch.assigneeId !== existing.assignedToOid);
  if (
    assigneeChanged &&
    patch.assigneeId &&
    patch.assigneeId !== APEX_ASSIGNEE_ID &&
    patch.assigneeId !== userId
  ) {
    const actor = await db.query.appUsers.findFirst({
      where: eq(appUsers.oid, userId),
    });
    const actorName = actor?.displayName ?? actor?.email ?? userId;
    createNotification(patch.assigneeId, {
      type: 'user-action',
      title: 'Work item assigned to you',
      body: `${actorName} assigned "${existing.title}" to you`,
      link: `/feature-requests?tab=${existing.type}&id=${id}`,
    }).catch(() => {});
  }

  let assigneeName: string | null = null;
  let assigneeEmail: string | null = null;
  if (row.assignedToOid) {
    const assignee = await db.query.appUsers.findFirst({
      where: eq(appUsers.oid, row.assignedToOid),
    });
    assigneeName = assignee?.displayName ?? null;
    assigneeEmail = assignee?.email ?? null;
  }
  return toFeatureRequest({ ...row, assigneeName, assigneeEmail });
}

export async function listFeatureRequestAssignees(project: string) {
  if (!project.trim()) throw httpError('project is required', 400);
  return listProjectAssignees(project.trim());
}

export async function rankFeatureRequests(
  userId: string,
  project: string,
  ids: string[],
): Promise<{ items: FeatureRequest[]; rankedAt: string }> {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) throw httpError('ids required', 400);
  if (uniqueIds.length !== ids.length) {
    throw httpError('ids must be unique', 400);
  }

  const rows = await db
    .select()
    .from(featureRequests)
    .where(inArray(featureRequests.id, uniqueIds));
  if (
    rows.length !== uniqueIds.length ||
    rows.some((row) => row.sourceProject !== project)
  ) {
    throw httpError(
      'One or more feature requests do not belong to the selected project',
      400,
    );
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const rankings = await generateFeatureRequestRankings(
    project,
    userId,
    uniqueIds.map((id) => {
      const row = byId.get(id)!;
      return {
        id: row.id,
        type: row.type as WorkItemType,
        title: row.title,
        request: row.request,
        advantage: row.advantage,
        status: row.status as FeatureRequestStatus,
        aiPriority: row.aiPriority as FeatureRequestPriority | null,
        aiRisk: row.aiRisk as FeatureRequestRisk | null,
        teamPriority: row.teamPriority as FeatureRequestPriority | null,
        teamRisk: row.teamRisk as FeatureRequestRisk | null,
      };
    }),
  );

  const rankedAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    for (let index = 0; index < rankings.length; index += 1) {
      const ranking = rankings[index];
      await tx
        .update(featureRequests)
        .set({
          rank: index + 1,
          aiPriority: ranking.priority,
          aiRationale: ranking.rationale,
          aiStatus: 'complete',
          reviewedBy: userId,
          updatedAt: rankedAt,
        })
        .where(
          and(
            eq(featureRequests.id, ranking.id),
            eq(featureRequests.sourceProject, project),
          ),
        );
    }
  });

  const rankedItems = await Promise.all(
    rankings.map(async (ranking) => {
      const item = await getFeatureRequest(ranking.id);
      if (!item) throw httpError('Feature request not found', 404);
      return item;
    }),
  );
  return { items: rankedItems, rankedAt };
}

// ── linkInterview ─────────────────────────────────────────────────────────────

export async function linkInterview(
  featureRequestId: string,
  interviewId: string,
): Promise<FeatureRequest> {
  const [row] = await db
    .update(featureRequests)
    .set({
      interviewId,
      status: 'in-interview',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(featureRequests.id, featureRequestId))
    .returning();

  return toFeatureRequest(row);
}

// ── resolveFeatureRequestReviewers ────────────────────────────────────────────

/**
 * Returns user IDs who hold `feature-requests:manage` for the given project,
 * unioned with super admins. Used for triage notifications.
 */
export async function resolveFeatureRequestReviewers(project: string): Promise<string[]> {
  const permissionRows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .innerJoin(appUserRoles, eq(userProjectAssignments.userId, appUserRoles.userId))
    .innerJoin(appRolePermissions, eq(appUserRoles.roleId, appRolePermissions.roleId))
    .innerJoin(appPermissions, eq(appRolePermissions.permissionId, appPermissions.id))
    .where(
      and(
        eq(userProjectAssignments.project, project),
        eq(appPermissions.key, 'feature-requests:manage'),
      ),
    );

  const userIds = new Set(permissionRows.map((r) => r.userId));

  // Union with super admins (looked up by email) for the current environment
  const superAdminEmails = getSuperAdminEmails();
  if (superAdminEmails.length > 0) {
    const superAdminRows = await db
      .select({ oid: appUsers.oid })
      .from(appUsers)
      .where(inArray(appUsers.email, superAdminEmails));

    for (const r of superAdminRows) {
      userIds.add(r.oid);
    }
  }

  return [...userIds];
}

/** @deprecated Use resolveFeatureRequestReviewers('Apex') instead */
export const resolveApexReviewers = () => resolveFeatureRequestReviewers('Apex');
