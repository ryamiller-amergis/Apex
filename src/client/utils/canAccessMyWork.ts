/**
 * Single source of truth for My Work (dev workbench) client access.
 *
 * Mirrors the server gate on the `/api/dev-workbench` router, where
 * `requireGroupMembership('Developer')` also admits super admins and
 * Project Admins (`admin:roles`).
 *
 * Rule: super admin, or (`my-work` menu enabled and `dev-workbench:view`
 * and (Developer group or `admin:roles`)).
 */

export interface MyWorkAccessContext {
  can: (key: string) => boolean;
  isSuperAdmin: boolean;
  /** Absent in surfaces that do not receive group membership; treated as no membership. */
  isInAnyGroup?: (groups: string[]) => boolean;
  /** Menu views enabled for the selected project. */
  enabledViews: string[];
}

export function canAccessMyWork({
  can,
  isSuperAdmin,
  isInAnyGroup,
  enabledViews,
}: MyWorkAccessContext): boolean {
  if (isSuperAdmin) return true;
  if (!enabledViews.includes('my-work')) return false;
  if (!can('dev-workbench:view')) return false;
  return (isInAnyGroup?.(['Developer']) ?? false) || can('admin:roles');
}
