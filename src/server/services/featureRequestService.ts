import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appPermissions,
  appRolePermissions,
  appUserRoles,
  appUsers,
  featureRequests,
  userProjectAssignments,
} from '../db/schema';
import type {
  FeatureRequest,
  FeatureRequestAiStatus,
  FeatureRequestStatus,
  FeatureRequestPriority,
  FeatureRequestRisk,
  UpdateFeatureRequestDTO,
} from '../../shared/types/featureRequest';
import { getSuperAdminEmails } from '../utils/superAdmin';

// ── Row → shared type mapper ──────────────────────────────────────────────────

interface FeatureRequestRow {
  id: string;
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

function toFeatureRequest(row: FeatureRequestRow): FeatureRequest {
  return {
    id: row.id,
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
  };
}

// ── createFeatureRequest ──────────────────────────────────────────────────────

export async function createFeatureRequest(
  userId: string,
  project: string,
  data: { title: string; request: string; advantage: string },
): Promise<FeatureRequest> {
  const [row] = await db
    .insert(featureRequests)
    .values({
      title: data.title,
      request: data.request,
      advantage: data.advantage,
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

  return rows.map(toFeatureRequest);
}

// ── getFeatureRequest ─────────────────────────────────────────────────────────

export async function getFeatureRequest(id: string): Promise<FeatureRequest | null> {
  const rows = await db
    .select({
      id: featureRequests.id,
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
  return toFeatureRequest(rows[0]);
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
