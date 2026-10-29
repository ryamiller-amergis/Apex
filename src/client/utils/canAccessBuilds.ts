/**
 * Single source of truth for Builds client access. The header, sidebar and
 * route guard all call this, so they cannot disagree. The server is the control.
 *
 * Rule: flag on, and (super admin, or (`builds` menu enabled and `builds:view`)).
 * Super admins skip the menu and permission checks but not the flag.
 */

export interface BuildsAccessContext {
  can: (key: string) => boolean;
  isSuperAdmin: boolean;
  /** Menu views enabled for the selected project. */
  enabledViews: string[];
  /** `build-from-prompt` evaluated for this user and project. */
  flagEnabled: boolean;
}

export function canAccessBuilds({ can, isSuperAdmin, enabledViews, flagEnabled }: BuildsAccessContext): boolean {
  // @feature-flag:build-from-prompt start winner=enabled
  if (!flagEnabled) {
    // @feature-flag:build-from-prompt disabled-start
    return false;
    // @feature-flag:build-from-prompt disabled-end
  }
  // @feature-flag:build-from-prompt enabled-start
  if (isSuperAdmin) return true;
  return enabledViews.includes('builds') && can('builds:view');
  // @feature-flag:build-from-prompt enabled-end
  // @feature-flag:build-from-prompt end
}
