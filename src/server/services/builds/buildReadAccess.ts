/**
 * Read-access enforcement for Build verification and evidence routes (TBI-021, PBI-023, S7).
 *
 * Loads the build row from `build_runs` and verifies that the caller holds `builds:view`
 * and is assigned to the build's own project (`build.project`), regardless of what project
 * was named in the request query, params, body, or `x-apex-project` header.
 */
import { eq } from 'drizzle-orm';
import type { Request } from 'express';
import { db } from '../../db/drizzle';
import { buildRuns } from '../../db/schema';
import { resolveRequestProject } from '../../middleware/rbac';
import { getUserPermissions } from '../rbacService';
import { getAssignmentsForUser } from '../userProjectAssignmentService';
import { getUserId } from '../../utils/requestUser';
import { isSuperAdminRequest } from '../../utils/superAdmin';

export type BuildVerificationErrorCode =
  | 'BUILD_UNAUTHORIZED'
  | 'BUILD_FORBIDDEN'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_BAD_REQUEST'
  | 'BUILD_EVIDENCE_NOT_AVAILABLE';

function defaultStatusForCode(code: BuildVerificationErrorCode): number {
  switch (code) {
    case 'BUILD_UNAUTHORIZED':
      return 401;
    case 'BUILD_FORBIDDEN':
      return 403;
    case 'BUILD_NOT_FOUND':
    case 'BUILD_EVIDENCE_NOT_AVAILABLE':
      return 404;
    case 'BUILD_BAD_REQUEST':
      return 400;
  }
}

function defaultMessageForCode(code: BuildVerificationErrorCode): string {
  switch (code) {
    case 'BUILD_UNAUTHORIZED':
      return 'Unauthorized';
    case 'BUILD_FORBIDDEN':
      return 'Forbidden';
    case 'BUILD_NOT_FOUND':
      return 'Build not found';
    case 'BUILD_BAD_REQUEST':
      return 'Bad request';
    case 'BUILD_EVIDENCE_NOT_AVAILABLE':
      return 'This evidence is no longer available.';
  }
}

export class BuildVerificationError extends Error {
  readonly code: BuildVerificationErrorCode;
  readonly statusCode: number;

  constructor(
    code: BuildVerificationErrorCode,
    message: string = defaultMessageForCode(code),
    statusCode: number = defaultStatusForCode(code),
  ) {
    super(message);
    this.name = 'BuildVerificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type BuildRunRow = typeof buildRuns.$inferSelect;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export async function loadBuildRunById(buildId: string): Promise<BuildRunRow | null> {
  if (!isValidUuid(buildId)) {
    return null;
  }
  if (typeof db.query?.buildRuns?.findFirst === 'function') {
    const row = await db.query.buildRuns.findFirst({
      where: eq(buildRuns.id, buildId),
    });
    return (row as BuildRunRow | undefined) ?? null;
  }
  if (typeof db.select === 'function') {
    const rows = await db
      .select()
      .from(buildRuns)
      .where(eq(buildRuns.id, buildId))
      .limit(1);
    return (rows[0] as BuildRunRow | undefined) ?? null;
  }
  return null;
}

export async function assertBuildReadAccess(
  req: Request,
  buildId: string,
): Promise<{ build: BuildRunRow }> {
  const superAdmin = isSuperAdminRequest(req);
  const userId = getUserId(req);

  if (!superAdmin && (!req.user || !userId || userId === 'anonymous')) {
    throw new BuildVerificationError('BUILD_UNAUTHORIZED', 'Unauthorized', 401);
  }

  const build = await loadBuildRunById(buildId);
  if (!build) {
    throw new BuildVerificationError('BUILD_NOT_FOUND', 'Build not found', 404);
  }

  if (!superAdmin) {
    const [assignedProjects, permissions] = await Promise.all([
      getAssignmentsForUser(userId),
      getUserPermissions(userId, build.project),
    ]);

    if (!assignedProjects.includes(build.project) || !permissions.has('builds:view')) {
      throw new BuildVerificationError('BUILD_FORBIDDEN', 'Forbidden', 403);
    }
  }

  const requestProject = resolveRequestProject(req);
  if (requestProject && requestProject !== build.project) {
    throw new BuildVerificationError('BUILD_FORBIDDEN', 'Forbidden', 403);
  }

  return { build };
}
