import { asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appRoles, restrictedUserAccess } from '../db/schema';
import { assignRole } from './rbacService';
import { assignUserToProject } from './userProjectAssignmentService';
import { CONFIGURABLE_MENU_ITEMS, type MenuItemKey } from '../../shared/types/menuSettings';
import {
  RESTRICTED_ACCESS_PROJECT,
  isRestrictedAccessEmail,
  type CreateRestrictedUserAccessRequest,
  type RestrictedUserAccess,
  type UpdateRestrictedUserAccessRequest,
} from '../../shared/types/restrictedAccess';

const validMenuItemKeys = new Set<MenuItemKey>(CONFIGURABLE_MENU_ITEMS.map((item) => item.key));

export class RestrictedAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestrictedAccessError';
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function assertValidModules(modules: unknown): asserts modules is MenuItemKey[] {
  if (!Array.isArray(modules) || !modules.every((m) => typeof m === 'string' && validMenuItemKeys.has(m as MenuItemKey))) {
    throw new RestrictedAccessError('modules must be an array of valid menu item keys');
  }
}

function mapRow(row: {
  id: string;
  email: string;
  roleId: string;
  modules: MenuItemKey[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  role: { name: string } | null;
}): RestrictedUserAccess {
  return {
    id: row.id,
    email: row.email,
    roleId: row.roleId,
    roleName: row.role?.name ?? '',
    modules: row.modules ?? [],
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listRestrictedAccess(): Promise<RestrictedUserAccess[]> {
  const rows = await db.query.restrictedUserAccess.findMany({
    with: { role: true },
    orderBy: [asc(restrictedUserAccess.email)],
  });
  return rows.map(mapRow);
}

export async function getRestrictedAccessByEmail(
  email: string,
): Promise<RestrictedUserAccess | null> {
  if (!email) return null;
  const normalized = normalizeEmail(email);
  const row = await db.query.restrictedUserAccess.findFirst({
    where: eq(restrictedUserAccess.email, normalized),
    with: { role: true },
  });
  return row ? mapRow(row) : null;
}

export async function getRestrictedAccessById(id: string): Promise<RestrictedUserAccess | null> {
  const row = await db.query.restrictedUserAccess.findFirst({
    where: eq(restrictedUserAccess.id, id),
    with: { role: true },
  });
  return row ? mapRow(row) : null;
}

async function assertRoleExists(roleId: string): Promise<void> {
  const role = await db.query.appRoles.findFirst({
    where: eq(appRoles.id, roleId),
  });
  if (!role) {
    throw new RestrictedAccessError('Role not found');
  }
}

export async function createRestrictedAccess(
  input: CreateRestrictedUserAccessRequest,
  createdBy?: string | null,
): Promise<RestrictedUserAccess> {
  const email = normalizeEmail(input.email ?? '');
  if (!isRestrictedAccessEmail(email)) {
    throw new RestrictedAccessError('A valid email address is required');
  }
  if (!input.roleId || typeof input.roleId !== 'string') {
    throw new RestrictedAccessError('roleId is required');
  }
  assertValidModules(input.modules);
  await assertRoleExists(input.roleId);

  const existing = await getRestrictedAccessByEmail(email);
  if (existing) {
    throw new RestrictedAccessError('A restricted access entry already exists for this email');
  }

  const now = new Date().toISOString();
  const [inserted] = await db
    .insert(restrictedUserAccess)
    .values({
      email,
      roleId: input.roleId,
      modules: input.modules,
      enabled: input.enabled ?? true,
      createdBy: createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: restrictedUserAccess.id });

  const created = await getRestrictedAccessById(inserted.id);
  if (!created) {
    throw new RestrictedAccessError('Failed to create restricted access entry');
  }
  return created;
}

export async function updateRestrictedAccess(
  id: string,
  input: UpdateRestrictedUserAccessRequest,
): Promise<RestrictedUserAccess> {
  const existing = await getRestrictedAccessById(id);
  if (!existing) {
    throw new RestrictedAccessError('Restricted access entry not found');
  }

  const updates: {
    email?: string;
    roleId?: string;
    modules?: MenuItemKey[];
    enabled?: boolean;
    updatedAt: string;
  } = { updatedAt: new Date().toISOString() };

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (!isRestrictedAccessEmail(email)) {
      throw new RestrictedAccessError('A valid email address is required');
    }
    if (email !== existing.email) {
      const conflict = await getRestrictedAccessByEmail(email);
      if (conflict && conflict.id !== id) {
        throw new RestrictedAccessError('A restricted access entry already exists for this email');
      }
    }
    updates.email = email;
  }

  if (input.roleId !== undefined) {
    if (!input.roleId) {
      throw new RestrictedAccessError('roleId is required');
    }
    await assertRoleExists(input.roleId);
    updates.roleId = input.roleId;
  }

  if (input.modules !== undefined) {
    assertValidModules(input.modules);
    updates.modules = input.modules;
  }

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') {
      throw new RestrictedAccessError('enabled must be a boolean');
    }
    updates.enabled = input.enabled;
  }

  await db
    .update(restrictedUserAccess)
    .set(updates)
    .where(eq(restrictedUserAccess.id, id));

  const updated = await getRestrictedAccessById(id);
  if (!updated) {
    throw new RestrictedAccessError('Restricted access entry not found after update');
  }
  return updated;
}

export async function deleteRestrictedAccess(id: string): Promise<void> {
  const existing = await getRestrictedAccessById(id);
  if (!existing) {
    throw new RestrictedAccessError('Restricted access entry not found');
  }
  await db.delete(restrictedUserAccess).where(eq(restrictedUserAccess.id, id));
}

/**
 * Idempotently assign the configured role and bind the user to the internal
 * Apex project token so project-scoped endpoints keep working.
 */
export async function ensureRestrictedAccessApplied(
  userId: string,
  roleId: string,
  assignedBy = 'restricted-access',
): Promise<void> {
  await assignRole(userId, roleId, assignedBy);
  await assignUserToProject(userId, RESTRICTED_ACCESS_PROJECT, assignedBy);
}
