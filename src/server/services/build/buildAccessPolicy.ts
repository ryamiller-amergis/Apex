/**
 * Shared build access policy helper (FEAT-014, FEAT-015, FEAT-016).
 *
 * Allows the build's requester, a Project Admin (`admin:roles` in the build's project),
 * or a Platform Admin (`isSuperAdmin`).
 */
export interface BuildActorContext {
  userId: string;
  displayName?: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
}

export function canActOnBuild(
  actor: BuildActorContext,
  build: { requesterUserId: string }
):
  | { allowed: true; authorization: 'requester' | 'administrator' }
  | { allowed: false } {
  if (!actor.userId || actor.userId === 'anonymous') {
    return { allowed: false };
  }
  if (actor.userId === build.requesterUserId) {
    return { allowed: true, authorization: 'requester' };
  }
  if (actor.isSuperAdmin || actor.isProjectAdmin) {
    return { allowed: true, authorization: 'administrator' };
  }
  return { allowed: false };
}
