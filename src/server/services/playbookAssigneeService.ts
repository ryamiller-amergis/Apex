/**
 * People an interactive Playbook step can be assigned to: the project's Azure DevOps team members.
 * A step stores the person's email. It runs only once that email has an Apex account that can run
 * Playbooks in the project, because the assignee chats and approves inside Apex.
 */
import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { appUsers } from '../db/schema';
import { isSuperAdminEmail } from '../utils/superAdmin';
import { listProjectMembers } from './adoMembershipService';
import { getUserPermissions } from './rbacService';

export interface PlaybookAssigneeOption {
  email: string;
  displayName: string;
  /** Set when the person has signed in to Apex. */
  apexUserId: string | null;
  canRunPlaybooks: boolean;
}

async function canRunPlaybooks(user: { oid: string; email: string | null }, project: string): Promise<boolean> {
  if (user.email && isSuperAdminEmail(user.email)) return true;
  return (await getUserPermissions(user.oid, project)).has('playbooks:run');
}

async function apexUsersByEmail(emails: string[]): Promise<Map<string, { oid: string; email: string | null }>> {
  if (emails.length === 0) return new Map();
  const rows = await db
    .select({ oid: appUsers.oid, email: appUsers.email })
    .from(appUsers)
    .where(inArray(sql`lower(${appUsers.email})`, emails.map((email) => email.toLowerCase())));
  return new Map(rows.filter((row) => row.email).map((row) => [row.email!.toLowerCase(), row]));
}

export async function listPlaybookAssignees(project: string): Promise<PlaybookAssigneeOption[]> {
  const members = await listProjectMembers(project);
  const users = await apexUsersByEmail(members.map((member) => member.email));
  return Promise.all(members.map(async (member) => {
    const user = users.get(member.email.toLowerCase());
    return {
      email: member.email,
      displayName: member.displayName,
      apexUserId: user?.oid ?? null,
      canRunPlaybooks: user ? await canRunPlaybooks(user, project) : false,
    };
  }));
}

/** The Apex account for an assignee email, or null when that person has not signed in yet. */
export async function apexUserIdForEmail(email: string): Promise<string | null> {
  const user = (await apexUsersByEmail([email])).get(email.toLowerCase());
  return user?.oid ?? null;
}
