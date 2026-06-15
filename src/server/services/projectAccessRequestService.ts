import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, projectAccessRequests, userProjectAssignments } from '../db/schema';
import { getAssignmentsForUser } from './userProjectAssignmentService';
import { listProjectCatalog } from './projectCatalogService';
import type {
  PlatformAdminAccessRequest,
  PlatformAdminProject,
  ProjectAccessRequest,
  ProjectAccessRequestStatus,
} from '../../shared/types/platformAdmin';

type RequestRow = {
  id: string;
  userId: string;
  project: string;
  status: ProjectAccessRequestStatus;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type AdminRequestRow = RequestRow & {
  displayName: string | null;
  email: string | null;
};

function normalizeProjects(projects: string[]): string[] {
  const byLowerName = new Map<string, string>();

  projects.forEach((project) => {
    const normalized = project.trim();
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!byLowerName.has(key)) byLowerName.set(key, normalized);
  });

  return [...byLowerName.values()];
}

function toRequest(row: RequestRow): ProjectAccessRequest {
  return {
    id: row.id,
    userId: row.userId,
    project: row.project,
    status: row.status,
    requestedAt: row.requestedAt,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
  };
}

function toAdminRequest(row: AdminRequestRow): PlatformAdminAccessRequest {
  return {
    ...toRequest(row),
    displayName: row.displayName ?? row.userId,
    email: row.email ?? '',
  };
}

function requestSelect() {
  return {
    id: projectAccessRequests.id,
    userId: projectAccessRequests.userId,
    project: projectAccessRequests.project,
    status: projectAccessRequests.status,
    requestedAt: projectAccessRequests.requestedAt,
    reviewedBy: projectAccessRequests.reviewedBy,
    reviewedAt: projectAccessRequests.reviewedAt,
    reviewNote: projectAccessRequests.reviewNote,
  };
}

function adminRequestSelect() {
  return {
    ...requestSelect(),
    displayName: appUsers.displayName,
    email: appUsers.email,
  };
}

export async function listCurrentUserAccessRequests(userId: string): Promise<ProjectAccessRequest[]> {
  const rows = await db
    .select(requestSelect())
    .from(projectAccessRequests)
    .where(eq(projectAccessRequests.userId, userId))
    .orderBy(desc(projectAccessRequests.requestedAt));

  return rows.map(toRequest);
}

export async function listRequestableProjectsForUser(userId: string): Promise<PlatformAdminProject[]> {
  const [catalog, assignedProjects, requests] = await Promise.all([
    listProjectCatalog(),
    getAssignmentsForUser(userId),
    listCurrentUserAccessRequests(userId),
  ]);
  const assigned = new Set(assignedProjects.map((project) => project.toLowerCase()));
  const pending = new Set(
    requests
      .filter((request) => request.status === 'pending')
      .map((request) => request.project.toLowerCase()),
  );

  return catalog.filter((project) => {
    const key = project.name.toLowerCase();
    return !assigned.has(key) && !pending.has(key);
  });
}

export async function createProjectAccessRequests(
  userId: string,
  projects: string[],
): Promise<ProjectAccessRequest[]> {
  const requestedProjects = normalizeProjects(projects);
  if (requestedProjects.length === 0) return [];

  const [catalog, assignedProjects, existingPendingRequests] = await Promise.all([
    listProjectCatalog(),
    getAssignmentsForUser(userId),
    db
      .select({ project: projectAccessRequests.project })
      .from(projectAccessRequests)
      .where(and(eq(projectAccessRequests.userId, userId), eq(projectAccessRequests.status, 'pending'))),
  ]);
  const catalogByName = new Map(catalog.map((project) => [project.name.toLowerCase(), project.name]));
  const assigned = new Set(assignedProjects.map((project) => project.toLowerCase()));
  const pending = new Set(existingPendingRequests.map((row) => row.project.toLowerCase()));
  const projectsToCreate = requestedProjects.flatMap((project) => {
    const key = project.toLowerCase();
    const catalogName = catalogByName.get(key);
    if (!catalogName || assigned.has(key) || pending.has(key)) return [];
    return [catalogName];
  });

  if (projectsToCreate.length === 0) return [];

  const rows = await db
    .insert(projectAccessRequests)
    .values(projectsToCreate.map((project) => ({ userId, project })))
    .onConflictDoNothing()
    .returning(requestSelect());

  return rows.map(toRequest);
}

export async function listPlatformAdminAccessRequests(
  status: ProjectAccessRequestStatus | 'all' = 'pending',
): Promise<PlatformAdminAccessRequest[]> {
  const base = db
    .select(adminRequestSelect())
    .from(projectAccessRequests)
    .innerJoin(appUsers, eq(projectAccessRequests.userId, appUsers.oid));

  const rows = status === 'all'
    ? await base.orderBy(desc(projectAccessRequests.requestedAt), asc(projectAccessRequests.project))
    : await base
      .where(eq(projectAccessRequests.status, status))
      .orderBy(desc(projectAccessRequests.requestedAt), asc(projectAccessRequests.project));

  return rows.map(toAdminRequest);
}

export async function approveProjectAccessRequest(
  requestId: string,
  reviewedBy?: string | null,
  reviewNote?: string | null,
): Promise<PlatformAdminAccessRequest | null> {
  const reviewedAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select(adminRequestSelect())
      .from(projectAccessRequests)
      .innerJoin(appUsers, eq(projectAccessRequests.userId, appUsers.oid))
      .where(eq(projectAccessRequests.id, requestId));

    if (!request || request.status !== 'pending') return null;

    await tx
      .insert(userProjectAssignments)
      .values({
        userId: request.userId,
        project: request.project,
        assignedBy: reviewedBy ?? null,
        assignedAt: reviewedAt,
      })
      .onConflictDoUpdate({
        target: [userProjectAssignments.userId, userProjectAssignments.project],
        set: {
          assignedBy: reviewedBy ?? null,
          assignedAt: reviewedAt,
        },
      });

    await tx
      .update(projectAccessRequests)
      .set({
        status: 'approved',
        reviewedBy: reviewedBy ?? null,
        reviewedAt,
        reviewNote: reviewNote ?? null,
      })
      .where(eq(projectAccessRequests.id, requestId));

    return toAdminRequest({
      ...request,
      status: 'approved',
      reviewedBy: reviewedBy ?? null,
      reviewedAt,
      reviewNote: reviewNote ?? null,
    });
  });
}

export async function rejectProjectAccessRequest(
  requestId: string,
  reviewedBy?: string | null,
  reviewNote?: string | null,
): Promise<PlatformAdminAccessRequest | null> {
  const reviewedAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select(adminRequestSelect())
      .from(projectAccessRequests)
      .innerJoin(appUsers, eq(projectAccessRequests.userId, appUsers.oid))
      .where(eq(projectAccessRequests.id, requestId));

    if (!request || request.status !== 'pending') return null;

    await tx
      .update(projectAccessRequests)
      .set({
        status: 'rejected',
        reviewedBy: reviewedBy ?? null,
        reviewedAt,
        reviewNote: reviewNote ?? null,
      })
      .where(eq(projectAccessRequests.id, requestId));

    return toAdminRequest({
      ...request,
      status: 'rejected',
      reviewedBy: reviewedBy ?? null,
      reviewedAt,
      reviewNote: reviewNote ?? null,
    });
  });
}
