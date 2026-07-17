import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
import { getSuperAdminEmails } from '../utils/superAdmin';

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

export async function listFeatureRequests(): Promise<FeatureRequest[]> {
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
    })
    .from(featureRequests)
    .leftJoin(appUsers, eq(featureRequests.submittedBy, appUsers.oid))
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
    })
    .from(featureRequests)
    .leftJoin(appUsers, eq(featureRequests.submittedBy, appUsers.oid))
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
  const set: Record<string, unknown> = {
    reviewedBy: userId,
    updatedAt: new Date().toISOString(),
  };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.teamPriority !== undefined) set.teamPriority = patch.teamPriority;
  if (patch.teamRisk !== undefined) set.teamRisk = patch.teamRisk;
  if (patch.rank !== undefined) set.rank = patch.rank;

  const [row] = await db
    .update(featureRequests)
    .set(set)
    .where(eq(featureRequests.id, id))
    .returning();

  return toFeatureRequest(row);
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

// ── resolveApexReviewers ──────────────────────────────────────────────────────

export async function resolveApexReviewers(): Promise<string[]> {
  // Users assigned to 'Apex' project who hold the 'feature-requests:manage' permission
  const permissionRows = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .innerJoin(appUserRoles, eq(userProjectAssignments.userId, appUserRoles.userId))
    .innerJoin(appRolePermissions, eq(appUserRoles.roleId, appRolePermissions.roleId))
    .innerJoin(appPermissions, eq(appRolePermissions.permissionId, appPermissions.id))
    .where(
      and(
        eq(userProjectAssignments.project, 'Apex'),
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
