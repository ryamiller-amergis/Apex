import { db } from '../db/drizzle';
import { appGroups, appGroupMembers, appUsers } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { AppGroup, GroupMember, GroupWithMembers } from '../../shared/types/groups';

const DEFAULTS = [
  { name: 'Product-Owner', description: 'Product ownership and strategy' },
  { name: 'BA', description: 'Business analysis and requirements' },
  { name: 'UI/UX', description: 'User interface and experience design' },
  { name: 'Manager', description: 'Project and team management' },
  { name: 'Developer', description: 'Software development and engineering' },
  { name: 'QA', description: 'Quality assurance and test case review' },
];

export async function listGroups(project?: string): Promise<AppGroup[]> {
  if (project !== undefined) {
    const rows = await db.select().from(appGroups).where(eq(appGroups.project, project)).orderBy(appGroups.name);
    return rows as AppGroup[];
  }
  const rows = await db.select().from(appGroups).orderBy(appGroups.name);
  return rows as AppGroup[];
}

export async function listGroupsWithMembers(project?: string): Promise<GroupWithMembers[]> {
  const groups = await listGroups(project);
  if (groups.length === 0) return [];

  const allMembers = await db
    .select({
      groupId: appGroupMembers.groupId,
      userId: appGroupMembers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      addedBy: appGroupMembers.addedBy,
      addedAt: appGroupMembers.addedAt,
    })
    .from(appGroupMembers)
    .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid));

  const membersByGroup = new Map<string, GroupMember[]>();
  for (const m of allMembers) {
    const arr = membersByGroup.get(m.groupId) ?? [];
    arr.push(m);
    membersByGroup.set(m.groupId, arr);
  }

  return groups.map((g) => ({ ...g, members: membersByGroup.get(g.id) ?? [] }));
}

export async function getGroupWithMembers(id: string): Promise<GroupWithMembers | null> {
  const rows = await db.select().from(appGroups).where(eq(appGroups.id, id)).limit(1);
  if (rows.length === 0) return null;
  const group = rows[0] as AppGroup;

  const memberRows = await db
    .select({
      groupId: appGroupMembers.groupId,
      userId: appGroupMembers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      addedBy: appGroupMembers.addedBy,
      addedAt: appGroupMembers.addedAt,
    })
    .from(appGroupMembers)
    .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
    .where(eq(appGroupMembers.groupId, id));

  return { ...group, members: memberRows };
}

export async function createGroup(
  name: string,
  description?: string,
  createdBy?: string,
  project?: string,
  isDefault?: boolean,
): Promise<AppGroup> {
  const [row] = await db
    .insert(appGroups)
    .values({
      name,
      description: description ?? null,
      createdBy: createdBy ?? null,
      project: project ?? null,
      isDefault: isDefault ?? false,
    })
    .returning();
  return row as AppGroup;
}

export async function seedDefaultGroupsForProject(project: string, createdBy?: string): Promise<void> {
  await db
    .insert(appGroups)
    .values(
      DEFAULTS.map((d) => ({
        name: d.name,
        description: d.description,
        project,
        isDefault: true,
        createdBy: createdBy ?? null,
      })),
    )
    .onConflictDoNothing();
}

export async function updateGroup(id: string, updates: { name?: string; description?: string }): Promise<AppGroup> {
  const set: Record<string, unknown> = {};
  if (updates.name !== undefined) set.name = updates.name;
  if (updates.description !== undefined) set.description = updates.description;

  const rows = await db.update(appGroups).set(set).where(eq(appGroups.id, id)).returning();
  if (rows.length === 0) throw new Error(`Group not found: ${id}`);
  return rows[0] as AppGroup;
}

export async function deleteGroup(id: string): Promise<void> {
  await db.delete(appGroups).where(eq(appGroups.id, id));
}

export async function getUserGroupNames(userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: appGroups.name })
    .from(appGroupMembers)
    .innerJoin(appGroups, eq(appGroupMembers.groupId, appGroups.id))
    .where(eq(appGroupMembers.userId, userId));
  return [...new Set(rows.map(r => r.name))];
}

export async function setGroupMembers(groupId: string, userIds: string[], addedBy?: string): Promise<GroupMember[]> {
  await db.transaction(async (tx) => {
    await tx.delete(appGroupMembers).where(eq(appGroupMembers.groupId, groupId));

    if (userIds.length > 0) {
      await tx.insert(appGroupMembers).values(
        userIds.map((userId) => ({
          groupId,
          userId,
          addedBy: addedBy ?? null,
        })),
      );
    }
  });

  const memberRows = await db
    .select({
      groupId: appGroupMembers.groupId,
      userId: appGroupMembers.userId,
      displayName: appUsers.displayName,
      email: appUsers.email,
      addedBy: appGroupMembers.addedBy,
      addedAt: appGroupMembers.addedAt,
    })
    .from(appGroupMembers)
    .innerJoin(appUsers, eq(appGroupMembers.userId, appUsers.oid))
    .where(eq(appGroupMembers.groupId, groupId));

  return memberRows;
}
