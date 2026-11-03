/**
 * Brainstorm facts about a chat thread. Imports only leaf services:
 * `threadAccessService` uses this inside the durable admit call graph.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { brainstormSessions } from '../db/schema';
import type { ChatThread } from '../../shared/types/chat';
import { BRAINSTORM_FLAG } from '../../shared/types/brainstorm';
import { getUserPermissions } from './rbacService';
import { getAssignmentsForUser } from './userProjectAssignmentService';
import { isFeatureEnabled } from './featureFlagService';
import { isSuperAdminUserId } from '../utils/superAdminUser';
import {
  decideBrainstormAccess,
  type BrainstormSessionFacts,
  type BrainstormViewer,
} from './brainstormAccessPolicy';

export function isBrainstormThread(thread: Pick<ChatThread, 'kickoff'>): boolean {
  return thread.kickoff.agentModule === 'brainstorm';
}

export type BrainstormSessionRow = typeof brainstormSessions.$inferSelect;

/** Loads a session only within the named project. */
export async function loadBrainstormSession(
  sessionId: string,
  project: string,
): Promise<BrainstormSessionRow | null> {
  const [row] = await db
    .select()
    .from(brainstormSessions)
    .where(and(eq(brainstormSessions.id, sessionId), eq(brainstormSessions.project, project)))
    .limit(1);
  return row ?? null;
}

export async function findBrainstormSessionForThread(
  threadId: string,
): Promise<(BrainstormSessionFacts & { id: string }) | null> {
  const [row] = await db
    .select({
      id: brainstormSessions.id,
      project: brainstormSessions.project,
      creatorId: brainstormSessions.creatorId,
      state: brainstormSessions.state,
    })
    .from(brainstormSessions)
    .where(eq(brainstormSessions.chatThreadId, threadId))
    .limit(1);
  return row ?? null;
}

export async function loadBrainstormViewer(
  userId: string,
  project: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<BrainstormViewer> {
  const [isSuperAdmin, assignments, permissions] = await Promise.all([
    options.isSuperAdmin === undefined ? isSuperAdminUserId(userId) : Promise.resolve(options.isSuperAdmin),
    getAssignmentsForUser(userId),
    getUserPermissions(userId, project),
  ]);
  return {
    id: userId,
    isSuperAdmin,
    isProjectMember: assignments.includes(project),
    permissions,
  };
}

/** Treats a flag lookup error as disabled. */
export function isBrainstormEnabled(userId: string, project: string): Promise<boolean> {
  return isFeatureEnabled(BRAINSTORM_FLAG, { userId, project, caller: 'brainstorm' }).catch(() => false);
}

/**
 * Thread access for a Brainstorm thread: `owner` for the creator, `read` for
 * other project members, null for everyone else and whenever the flag is off.
 */
export async function resolveBrainstormThreadAccess(
  userId: string,
  threadId: string,
): Promise<'owner' | 'read' | null> {
  const session = await findBrainstormSessionForThread(threadId);
  if (!session) return null;
  // @feature-flag:brainstorm start winner=enabled
  if (!(await isBrainstormEnabled(userId, session.project))) {
    // @feature-flag:brainstorm disabled-start
    return null;
    // @feature-flag:brainstorm disabled-end
  }
  // @feature-flag:brainstorm end
  const viewer = await loadBrainstormViewer(userId, session.project);
  const decision = decideBrainstormAccess({ viewer, project: session.project, session }, 'read');
  if (decision.kind === 'refuse') return null;
  return session.creatorId === userId ? 'owner' : 'read';
}
