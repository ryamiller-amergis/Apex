import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  appPermissions,
  appRolePermissions,
  appRoles,
  appUserProjectRoles,
  appUserRoles,
  appUsers,
  userProjectAssignments,
} from '../db/schema';
import type { AppPermission, AppRole, RoleWithPermissions, UserWithRoles } from '../../shared/types/rbac';
import type { ActiveUser } from '../../shared/types/interview';

// ── getUserPermissions ─────────────────────────────────────────────────────────

export async function getUserPermissions(userId: string, project?: string): Promise<Set<string>> {
  // Project-scoped resolution: if a project is provided, check for project-specific roles first
  if (project) {
    const projectRoleRows = await db.query.appUserProjectRoles.findMany({
      where: and(eq(appUserProjectRoles.userId, userId), eq(appUserProjectRoles.project, project)),
      with: {
        role: {
          with: {
            rolePermissions: {
              with: { permission: true },
            },
          },
        },
      },
    });

    if (projectRoleRows.length > 0) {
      const keys = new Set<string>();
      for (const ur of projectRoleRows) {
        for (const rp of ur.role.rolePermissions) {
          keys.add(rp.permission.key);
        }
      }
      return keys;
    }
  }

  // Global role resolution (original behavior)
  const userRoleRows = await db.query.appUserRoles.findMany({
    where: eq(appUserRoles.userId, userId),
    with: {
      role: {
        with: {
          rolePermissions: {
            with: { permission: true },
          },
        },
      },
    },
  });

  if (userRoleRows.length > 0) {
    const keys = new Set<string>();
    for (const ur of userRoleRows) {
      for (const rp of ur.role.rolePermissions) {
        keys.add(rp.permission.key);
      }
    }
    return keys;
  }

  // Fall back to the default role when the user has no explicit assignments
  const defaultRole = await db.query.appRoles.findFirst({
    where: eq(appRoles.isDefault, true),
    with: {
      rolePermissions: {
        with: { permission: true },
      },
    },
  });

  const keys = new Set<string>();
  if (defaultRole) {
    for (const rp of defaultRole.rolePermissions) {
      keys.add(rp.permission.key);
    }
  }
  return keys;
}

// ── listRoles ─────────────────────────────────────────────────────────────────

export async function listRoles(): Promise<RoleWithPermissions[]> {
  const rows = await db.query.appRoles.findMany({
    with: {
      rolePermissions: {
        with: { permission: true },
      },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isDefault: r.isDefault,
    createdAt: r.createdAt,
    permissions: r.rolePermissions.map((rp) => rp.permission.key),
  }));
}

// ── getRole ───────────────────────────────────────────────────────────────────

export async function getRole(id: string): Promise<RoleWithPermissions | null> {
  const r = await db.query.appRoles.findFirst({
    where: eq(appRoles.id, id),
    with: {
      rolePermissions: {
        with: { permission: true },
      },
    },
  });

  if (!r) return null;

  return {
    id: r.id,
    name: r.name,
    description: r.description,
    isDefault: r.isDefault,
    createdAt: r.createdAt,
    permissions: r.rolePermissions.map((rp) => rp.permission.key),
  };
}

// ── createRole ────────────────────────────────────────────────────────────────

export async function createRole(
  name: string,
  description: string | undefined,
  permissionIds: string[],
): Promise<AppRole> {
  return db.transaction(async (tx) => {
    const [role] = await tx
      .insert(appRoles)
      .values({ name, description: description ?? null })
      .returning();

    if (permissionIds.length > 0) {
      await tx.insert(appRolePermissions).values(
        permissionIds.map((permissionId) => ({ roleId: role.id, permissionId })),
      );
    }

    return role;
  });
}

// ── updateRole ────────────────────────────────────────────────────────────────

export async function updateRole(
  id: string,
  updates: { name?: string; description?: string; isDefault?: boolean },
): Promise<void> {
  const set: Partial<typeof appRoles.$inferInsert> = {};
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.description !== undefined) set.description = updates.description;
  if (updates.isDefault !== undefined) set.isDefault = updates.isDefault;

  if (Object.keys(set).length === 0) return;

  await db.update(appRoles).set(set).where(eq(appRoles.id, id));
}

// ── updateRolePermissions ─────────────────────────────────────────────────────

export async function updateRolePermissions(
  roleId: string,
  permissionIds: string[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(appRolePermissions).where(eq(appRolePermissions.roleId, roleId));

    if (permissionIds.length > 0) {
      await tx.insert(appRolePermissions).values(
        permissionIds.map((permissionId) => ({ roleId, permissionId })),
      );
    }
  });
}

// ── deleteRole ────────────────────────────────────────────────────────────────

export async function deleteRole(id: string): Promise<void> {
  const role = await db.query.appRoles.findFirst({ where: eq(appRoles.id, id) });

  if (role?.isDefault) {
    throw new Error('Cannot delete the default role');
  }

  await db.delete(appRoles).where(eq(appRoles.id, id));
}

// ── listPermissions ───────────────────────────────────────────────────────────

export async function listPermissions(): Promise<AppPermission[]> {
  return db
    .select()
    .from(appPermissions)
    .orderBy(asc(appPermissions.category), asc(appPermissions.key));
}

// ── listUsers ─────────────────────────────────────────────────────────────────

export async function listUsers(): Promise<UserWithRoles[]> {
  const rows = await db.query.appUsers.findMany({
    with: {
      userRoles: {
        with: { role: true },
      },
    },
  });

  return rows.map((u) => ({
    oid: u.oid,
    displayName: u.displayName,
    email: u.email,
    lastSeenAt: u.lastSeenAt,
    roles: u.userRoles.map((ur) => ur.role.name),
  }));
}

// ── listUsersForProject ────────────────────────────────────────────────────────

export async function listUsersForProject(project: string): Promise<UserWithRoles[]> {
  const assignments = await db
    .select({ userId: userProjectAssignments.userId })
    .from(userProjectAssignments)
    .where(eq(userProjectAssignments.project, project));

  if (assignments.length === 0) return [];

  const userIds = assignments.map((assignment) => assignment.userId);

  const [rows, projectRoleRows] = await Promise.all([
    db.query.appUsers.findMany({
      where: inArray(appUsers.oid, userIds),
      with: {
        userRoles: {
          with: { role: true },
        },
      },
    }),
    db.query.appUserProjectRoles.findMany({
      where: and(
        inArray(appUserProjectRoles.userId, userIds),
        eq(appUserProjectRoles.project, project),
      ),
      with: { role: true },
    }),
  ]);

  const projectRolesByUser = new Map<string, string[]>();
  for (const pr of projectRoleRows) {
    const list = projectRolesByUser.get(pr.userId) ?? [];
    list.push(pr.role.name);
    projectRolesByUser.set(pr.userId, list);
  }

  return rows.map((u) => ({
    oid: u.oid,
    displayName: u.displayName,
    email: u.email,
    lastSeenAt: u.lastSeenAt,
    roles: u.userRoles.map((ur) => ur.role.name),
    projectRoles: projectRolesByUser.get(u.oid) ?? [],
  }));
}

// ── assignRole ────────────────────────────────────────────────────────────────

export async function assignRole(
  userId: string,
  roleId: string,
  assignedBy: string,
): Promise<void> {
  await db
    .insert(appUserRoles)
    .values({ userId, roleId, assignedBy })
    .onConflictDoNothing();
}

// ── removeRole ────────────────────────────────────────────────────────────────

export async function removeRole(userId: string, roleId: string): Promise<void> {
  await db
    .delete(appUserRoles)
    .where(and(eq(appUserRoles.userId, userId), eq(appUserRoles.roleId, roleId)));
}

// ── getUserProjectRoles ────────────────────────────────────────────────────────

export async function getUserProjectRoles(userId: string, project: string): Promise<string[]> {
  const rows = await db.query.appUserProjectRoles.findMany({
    where: and(eq(appUserProjectRoles.userId, userId), eq(appUserProjectRoles.project, project)),
    with: { role: true },
  });
  return rows.map((r) => r.role.name);
}

// ── assignProjectRole ─────────────────────────────────────────────────────────

export async function assignProjectRole(
  userId: string,
  project: string,
  roleId: string,
  assignedBy: string,
): Promise<void> {
  await db
    .insert(appUserProjectRoles)
    .values({ userId, project, roleId, assignedBy })
    .onConflictDoNothing();
}

// ── removeProjectRole ─────────────────────────────────────────────────────────

export async function removeProjectRole(
  userId: string,
  project: string,
  roleId: string,
): Promise<void> {
  await db
    .delete(appUserProjectRoles)
    .where(
      and(
        eq(appUserProjectRoles.userId, userId),
        eq(appUserProjectRoles.project, project),
        eq(appUserProjectRoles.roleId, roleId),
      ),
    );
}

// ── getUserRoleNames ───────────────────────────────────────────────────────────

export async function getUserRoleNames(userId: string): Promise<string[]> {
  const assignments = await db.query.appUserRoles.findMany({
    where: eq(appUserRoles.userId, userId),
    with: { role: true },
  });
  if (assignments.length === 0) {
    const defaultRole = await db.query.appRoles.findFirst({
      where: eq(appRoles.isDefault, true),
    });
    return defaultRole ? [defaultRole.name] : [];
  }
  return assignments.map((a) => a.role.name);
}

// ── getChangelogPrefs ──────────────────────────────────────────────────────────

export async function getChangelogPrefs(userId: string): Promise<{
  lastSeenVersion: string | null;
  showOnLogin: boolean;
  dismissedBetaProdAnnouncement: boolean;
}> {
  const user = await db.query.appUsers.findFirst({ where: eq(appUsers.oid, userId) });
  return {
    lastSeenVersion: user?.lastSeenChangelogVersion ?? null,
    showOnLogin: user?.showChangelogOnLogin ?? true,
    dismissedBetaProdAnnouncement: user?.dismissedBetaProdAnnouncement ?? false,
  };
}

// ── updateChangelogPrefs ───────────────────────────────────────────────────────

export async function updateChangelogPrefs(
  userId: string,
  updates: { lastSeenChangelogVersion?: string; showChangelogOnLogin?: boolean; dismissedBetaProdAnnouncement?: boolean },
): Promise<void> {
  const set: Partial<typeof appUsers.$inferInsert> = {};
  if (updates.lastSeenChangelogVersion !== undefined) set.lastSeenChangelogVersion = updates.lastSeenChangelogVersion;
  if (updates.showChangelogOnLogin !== undefined) set.showChangelogOnLogin = updates.showChangelogOnLogin;
  if (updates.dismissedBetaProdAnnouncement !== undefined) set.dismissedBetaProdAnnouncement = updates.dismissedBetaProdAnnouncement;
  if (Object.keys(set).length === 0) return;
  await db.update(appUsers).set(set).where(eq(appUsers.oid, userId));
}

// ── upsertAppUser ─────────────────────────────────────────────────────────────

export async function upsertAppUser(
  oid: string,
  displayName: string,
  email: string,
): Promise<void> {
  await db
    .insert(appUsers)
    .values({ oid, displayName, email, lastSeenAt: new Date().toISOString() })
    .onConflictDoUpdate({
      target: appUsers.oid,
      set: { displayName, email, lastSeenAt: new Date().toISOString() },
    });
}

// ── getActiveUsers ─────────────────────────────────────────────────────────────

export async function getActiveUsers(project?: string): Promise<ActiveUser[]> {
  let projectUserIds: string[] | undefined;
  if (project) {
    const assignments = await db
      .select({ userId: userProjectAssignments.userId })
      .from(userProjectAssignments)
      .where(eq(userProjectAssignments.project, project));

    projectUserIds = assignments.map((assignment) => assignment.userId);
    if (projectUserIds.length === 0) return [];
  }

  const rows = await db
    .select({
      oid: appUsers.oid,
      displayName: appUsers.displayName,
      email: appUsers.email,
    })
    .from(appUsers)
    .where(
      projectUserIds
        ? and(isNotNull(appUsers.lastSeenAt), inArray(appUsers.oid, projectUserIds))
        : isNotNull(appUsers.lastSeenAt),
    )
    .orderBy(asc(appUsers.displayName));

  return rows;
}
