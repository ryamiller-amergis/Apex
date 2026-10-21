import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers, userProjectAssignments } from '../db/schema';
import {
  APEX_ASSIGNEE_ID,
  type WorkItemOwnerSummary,
} from '../../shared/types/apexWorkItem';

export const APEX_OWNER: WorkItemOwnerSummary = {
  oid: APEX_ASSIGNEE_ID,
  displayName: 'Apex',
  email: '',
  isApex: true,
};

function httpError(message: string, status = 400): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function toOwnerSummary(row: {
  oid: string;
  displayName: string | null;
  email: string | null;
}): WorkItemOwnerSummary {
  return {
    oid: row.oid,
    displayName: row.displayName ?? row.email ?? row.oid,
    email: row.email ?? '',
  };
}

export async function assertEligibleHumanAssignee(
  project: string,
  oid: string,
): Promise<void> {
  const rows = await db
    .select({ oid: appUsers.oid })
    .from(appUsers)
    .innerJoin(
      userProjectAssignments,
      eq(userProjectAssignments.userId, appUsers.oid),
    )
    .where(
      and(
        eq(appUsers.oid, oid),
        eq(userProjectAssignments.project, project),
      ),
    )
    .limit(1);
  if (!rows.length) {
    throw httpError(
      'Assignee must be a member of the selected project',
      400,
    );
  }
}

export async function listProjectAssignees(
  project: string,
): Promise<WorkItemOwnerSummary[]> {
  const rows = await db
    .select({
      oid: appUsers.oid,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(appUsers)
    .innerJoin(
      userProjectAssignments,
      eq(userProjectAssignments.userId, appUsers.oid),
    )
    .where(eq(userProjectAssignments.project, project));

  const seen = new Set<string>();
  const humans = rows
    .filter((row) => {
      if (seen.has(row.oid)) return false;
      seen.add(row.oid);
      return true;
    })
    .map(toOwnerSummary);
  return [APEX_OWNER, ...humans];
}
