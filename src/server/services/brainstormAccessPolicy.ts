import {
  BRAINSTORM_CREATE,
  BRAINSTORM_VIEW,
  type BrainstormSessionState,
} from '../../shared/types/brainstorm';

/**
 * Pure Brainstorm access decision. Callers pass plain facts; this makes no
 * database call, so every rule is testable without a database.
 */

export type BrainstormAccessMode = 'read' | 'mutate' | 'delete';

export interface BrainstormViewer {
  id: string;
  isSuperAdmin: boolean;
  /** Assigned to the project being requested. */
  isProjectMember: boolean;
  permissions: ReadonlySet<string>;
}

export interface BrainstormSessionFacts {
  project: string;
  creatorId: string;
  state: BrainstormSessionState;
}

export type BrainstormRefusalReason =
  | 'not_found'
  | 'forbidden'
  | 'not_creator'
  | 'session_not_active';

export type BrainstormAccessDecision =
  | { kind: 'read' }
  | { kind: 'mutate' }
  | { kind: 'delete' }
  | { kind: 'refuse'; reason: BrainstormRefusalReason };

export interface BrainstormAccessInput {
  viewer: BrainstormViewer;
  /** Project the request names. */
  project: string;
  /** Null when no session matched the id within that project. */
  session: BrainstormSessionFacts | null;
}

function has(viewer: BrainstormViewer, permission: string): boolean {
  return viewer.isSuperAdmin || viewer.permissions.has(permission);
}

export function decideBrainstormAccess(
  input: BrainstormAccessInput,
  mode: BrainstormAccessMode,
): BrainstormAccessDecision {
  const { viewer, project, session } = input;
  // Another project's session and a missing session look the same to the caller.
  if (!session || session.project !== project) return { kind: 'refuse', reason: 'not_found' };
  if (!viewer.isSuperAdmin && !viewer.isProjectMember) return { kind: 'refuse', reason: 'not_found' };
  if (!has(viewer, BRAINSTORM_VIEW)) return { kind: 'refuse', reason: 'forbidden' };
  if (mode === 'read') return { kind: 'read' };

  if (mode === 'delete') {
    if (viewer.isSuperAdmin) return { kind: 'delete' };
    if (session.creatorId !== viewer.id) return { kind: 'refuse', reason: 'not_creator' };
    if (!has(viewer, BRAINSTORM_CREATE)) return { kind: 'refuse', reason: 'forbidden' };
    return { kind: 'delete' };
  }

  // Super Admins read every session but change only their own.
  if (session.creatorId !== viewer.id) return { kind: 'refuse', reason: 'not_creator' };
  if (!has(viewer, BRAINSTORM_CREATE)) return { kind: 'refuse', reason: 'forbidden' };
  if (session.state !== 'active') return { kind: 'refuse', reason: 'session_not_active' };
  return { kind: 'mutate' };
}

export function canMutateBrainstormSession(input: BrainstormAccessInput): boolean {
  return decideBrainstormAccess(input, 'mutate').kind === 'mutate';
}

export function canDeleteBrainstormSession(input: BrainstormAccessInput): boolean {
  return decideBrainstormAccess(input, 'delete').kind === 'delete';
}
