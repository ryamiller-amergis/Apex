import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appRoles,
  appUserProjectRoles,
  appUserRoles,
  appUsers,
  rfpIntakeSubmitRequests,
} from '../db/schema';
import { createNotification } from './notificationService';
import { getUserPermissions } from './rbacService';
import { isSuperAdminEmail } from '../utils/superAdmin';
import {
  RFP_INTAKE_SUBMIT,
  RFP_SUBMITTER_ROLE,
  type PlatformAdminRfpSubmitAccessRequest,
  type RfpSubmitAccessRequest,
  type RfpSubmitAccessRequestStatus,
} from '../../shared/types/rfpIntake';

const APEX_PROJECT = 'Apex';

type RequestRow = {
  id: string;
  userId: string;
  status: RfpSubmitAccessRequestStatus;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
};

type AdminRequestRow = RequestRow & {
  displayName: string | null;
  email: string | null;
};

function toRequest(row: RequestRow): RfpSubmitAccessRequest {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    requestedAt: row.requestedAt,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    reviewNote: row.reviewNote,
  };
}

function toAdminRequest(row: AdminRequestRow): PlatformAdminRfpSubmitAccessRequest {
  return {
    ...toRequest(row),
    displayName: row.displayName ?? row.userId,
    email: row.email ?? '',
  };
}

function requestSelect() {
  return {
    id: rfpIntakeSubmitRequests.id,
    userId: rfpIntakeSubmitRequests.userId,
    status: rfpIntakeSubmitRequests.status,
    requestedAt: rfpIntakeSubmitRequests.requestedAt,
    reviewedBy: rfpIntakeSubmitRequests.reviewedBy,
    reviewedAt: rfpIntakeSubmitRequests.reviewedAt,
    reviewNote: rfpIntakeSubmitRequests.reviewNote,
  };
}

function adminRequestSelect() {
  return {
    ...requestSelect(),
    displayName: appUsers.displayName,
    email: appUsers.email,
  };
}

export async function userHasRfpSubmitAccess(userId: string): Promise<boolean> {
  const [globalPerms, apexPerms] = await Promise.all([
    getUserPermissions(userId),
    getUserPermissions(userId, APEX_PROJECT),
  ]);
  return globalPerms.has(RFP_INTAKE_SUBMIT) || apexPerms.has(RFP_INTAKE_SUBMIT);
}

async function notifySuperAdminsOfSubmitAccessRequest(
  requesterUserId: string,
): Promise<void> {
  const [requester] = await db
    .select({ displayName: appUsers.displayName, email: appUsers.email })
    .from(appUsers)
    .where(eq(appUsers.oid, requesterUserId));

  const requesterLabel = requester?.displayName || requester?.email || requesterUserId;
  const superAdminRows = await db
    .select({ oid: appUsers.oid, email: appUsers.email })
    .from(appUsers);

  const notifyTargets = superAdminRows.filter(
    (row) => row.email && isSuperAdminEmail(row.email) && row.oid !== requesterUserId,
  );

  await Promise.allSettled(
    notifyTargets.map((admin) =>
      createNotification(admin.oid, {
        type: 'user-action',
        title: 'New Request for Product access request',
        body: `${requesterLabel} asked to submit Requests for Product.`,
        link: '/platform-admin',
      }),
    ),
  );
}

async function notifyRequesterOfReview(
  requesterUserId: string,
  status: 'approved' | 'rejected',
  reviewNote?: string | null,
): Promise<void> {
  const approved = status === 'approved';
  await createNotification(requesterUserId, {
    type: 'user-action',
    title: approved
      ? 'Request for Product access approved'
      : 'Request for Product access declined',
    body: approved
      ? 'You can now submit a Request for Product from the home page.'
      : (reviewNote?.trim() || 'A platform admin declined your request to submit Requests for Product.'),
    link: '/',
  });
}

export async function listCurrentUserSubmitAccessRequests(
  userId: string,
): Promise<RfpSubmitAccessRequest[]> {
  const rows = await db
    .select(requestSelect())
    .from(rfpIntakeSubmitRequests)
    .where(eq(rfpIntakeSubmitRequests.userId, userId))
    .orderBy(desc(rfpIntakeSubmitRequests.requestedAt));

  return rows.map(toRequest);
}

export async function createRfpSubmitAccessRequest(
  userId: string,
): Promise<RfpSubmitAccessRequest | null> {
  if (await userHasRfpSubmitAccess(userId)) return null;

  const [existingPending] = await db
    .select(requestSelect())
    .from(rfpIntakeSubmitRequests)
    .where(and(
      eq(rfpIntakeSubmitRequests.userId, userId),
      eq(rfpIntakeSubmitRequests.status, 'pending'),
    ))
    .limit(1);

  if (existingPending) return toRequest(existingPending);

  const [row] = await db
    .insert(rfpIntakeSubmitRequests)
    .values({ userId })
    .returning(requestSelect());

  if (!row) return null;

  const created = toRequest(row);
  try {
    await notifySuperAdminsOfSubmitAccessRequest(userId);
  } catch (err) {
    console.error('[rfpSubmitAccessRequest] Failed to notify super admins:', (err as Error).message);
  }

  return created;
}

export async function listPlatformAdminRfpSubmitAccessRequests(
  status: RfpSubmitAccessRequestStatus | 'all' = 'pending',
): Promise<PlatformAdminRfpSubmitAccessRequest[]> {
  const base = db
    .select(adminRequestSelect())
    .from(rfpIntakeSubmitRequests)
    .innerJoin(appUsers, eq(rfpIntakeSubmitRequests.userId, appUsers.oid));

  const rows = status === 'all'
    ? await base.orderBy(desc(rfpIntakeSubmitRequests.requestedAt))
    : await base
      .where(eq(rfpIntakeSubmitRequests.status, status))
      .orderBy(desc(rfpIntakeSubmitRequests.requestedAt), asc(appUsers.displayName));

  return rows.map(toAdminRequest);
}

async function getRfpSubmitterRoleId(): Promise<string> {
  const role = await db.query.appRoles.findFirst({
    where: eq(appRoles.name, RFP_SUBMITTER_ROLE),
  });
  if (!role) {
    throw new Error(`Required role ${RFP_SUBMITTER_ROLE} is missing`);
  }
  return role.id;
}

export async function approveRfpSubmitAccessRequest(
  requestId: string,
  reviewedBy?: string | null,
  reviewNote?: string | null,
): Promise<PlatformAdminRfpSubmitAccessRequest | null> {
  const reviewedAt = new Date().toISOString();
  const roleId = await getRfpSubmitterRoleId();

  const approved = await db.transaction(async (tx) => {
    const [request] = await tx
      .select(adminRequestSelect())
      .from(rfpIntakeSubmitRequests)
      .innerJoin(appUsers, eq(rfpIntakeSubmitRequests.userId, appUsers.oid))
      .where(eq(rfpIntakeSubmitRequests.id, requestId));

    if (!request || request.status !== 'pending') return null;

    await tx
      .insert(appUserRoles)
      .values({
        userId: request.userId,
        roleId,
        assignedBy: reviewedBy ?? null,
        assignedAt: reviewedAt,
      })
      .onConflictDoNothing();

    const apexProjectRoles = await tx
      .select({ id: appUserProjectRoles.id })
      .from(appUserProjectRoles)
      .where(and(
        eq(appUserProjectRoles.userId, request.userId),
        eq(appUserProjectRoles.project, APEX_PROJECT),
      ))
      .limit(1);

    if (apexProjectRoles.length > 0) {
      await tx
        .insert(appUserProjectRoles)
        .values({
          userId: request.userId,
          project: APEX_PROJECT,
          roleId,
          assignedBy: reviewedBy ?? null,
          assignedAt: reviewedAt,
        })
        .onConflictDoNothing();
    }

    await tx
      .update(rfpIntakeSubmitRequests)
      .set({
        status: 'approved',
        reviewedBy: reviewedBy ?? null,
        reviewedAt,
        reviewNote: reviewNote ?? null,
      })
      .where(eq(rfpIntakeSubmitRequests.id, requestId));

    return toAdminRequest({
      ...request,
      status: 'approved',
      reviewedBy: reviewedBy ?? null,
      reviewedAt,
      reviewNote: reviewNote ?? null,
    });
  });

  if (approved) {
    try {
      await notifyRequesterOfReview(approved.userId, 'approved', reviewNote);
    } catch (err) {
      console.error('[rfpSubmitAccessRequest] Failed to notify requester:', (err as Error).message);
    }
  }

  return approved;
}

export async function rejectRfpSubmitAccessRequest(
  requestId: string,
  reviewedBy?: string | null,
  reviewNote?: string | null,
): Promise<PlatformAdminRfpSubmitAccessRequest | null> {
  const reviewedAt = new Date().toISOString();

  const rejected = await db.transaction(async (tx) => {
    const [request] = await tx
      .select(adminRequestSelect())
      .from(rfpIntakeSubmitRequests)
      .innerJoin(appUsers, eq(rfpIntakeSubmitRequests.userId, appUsers.oid))
      .where(eq(rfpIntakeSubmitRequests.id, requestId));

    if (!request || request.status !== 'pending') return null;

    await tx
      .update(rfpIntakeSubmitRequests)
      .set({
        status: 'rejected',
        reviewedBy: reviewedBy ?? null,
        reviewedAt,
        reviewNote: reviewNote ?? null,
      })
      .where(eq(rfpIntakeSubmitRequests.id, requestId));

    return toAdminRequest({
      ...request,
      status: 'rejected',
      reviewedBy: reviewedBy ?? null,
      reviewedAt,
      reviewNote: reviewNote ?? null,
    });
  });

  if (rejected) {
    try {
      await notifyRequesterOfReview(rejected.userId, 'rejected', reviewNote);
    } catch (err) {
      console.error('[rfpSubmitAccessRequest] Failed to notify requester:', (err as Error).message);
    }
  }

  return rejected;
}
