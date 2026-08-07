/**
 * Resolves the best landing route for a user based on Home access, RBAC
 * permissions, and project menu configuration.
 *
 * Rules mirror the sidebar and App.tsx route-guard logic exactly so that
 * the resolved route is always one the user can actually reach.
 *
 * Priority order:
 *   1. /home — when canAccessHome is true
 *   2. First accessible module in sidebar display order
 *   3. / (project selector) — when nothing else is accessible
 */

export interface AccessibleRouteContext {
  canAccessHome: boolean;
  can: (key: string) => boolean;
  isSuperAdmin: boolean;
  enabledViews: string[];
  selectedProject: string;
  isInAnyGroup: (groups: string[]) => boolean;
}

/**
 * Module entries in the same display order as the sidebar.
 * Each entry mirrors the visibility logic from AppSidebar.tsx.
 */
const MODULE_ORDER: ReadonlyArray<{
  view: string;
  route: string;
  isAccessible: (ctx: AccessibleRouteContext) => boolean;
}> = [
  {
    view: 'calendar',
    route: '/calendar',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('calendar') && can('calendar:view')),
  },
  {
    view: 'planning',
    route: '/planning/dev-stats',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('planning') && can('planning:view')),
  },
  {
    view: 'cloudcost',
    route: '/cloud-cost',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('cloudcost') && can('cost:view')),
  },
  {
    view: 'ai-cost',
    route: '/ai-cost',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('ai-cost') && can('analytics:ai-cost:view')),
  },
  {
    view: 'backlog',
    route: '/backlog',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('backlog') && can('interviews:view')),
  },
  {
    view: 'adr',
    route: '/adr',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('adr') && can('adr:view')),
  },
  {
    view: 'my-work',
    route: '/my-work',
    isAccessible: ({ can, isSuperAdmin, enabledViews, isInAnyGroup }) =>
      isSuperAdmin ||
      (enabledViews.includes('my-work') &&
        can('dev-workbench:view') &&
        isInAnyGroup(['Developer'])),
  },
  {
    view: 'standup',
    route: '/standup',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('standup') && can('standup:participate')),
  },
  {
    view: 'ui-lab',
    route: '/ui-lab',
    isAccessible: ({ can, isSuperAdmin, enabledViews, isInAnyGroup }) =>
      isSuperAdmin ||
      (enabledViews.includes('ui-lab') &&
        can('ui-lab:view') &&
        isInAnyGroup(['UI/UX'])),
  },
  {
    view: 'feature-requests',
    route: '/feature-requests',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin ||
      (enabledViews.includes('feature-requests') && can('feature-requests:view')),
  },
  {
    view: 'pdf-tools',
    route: '/pdf-tools',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('pdf-tools') && can('pdf-assembly:use')),
  },
  {
    view: 'design-module',
    route: '/design-module',
    isAccessible: ({ can, isSuperAdmin, enabledViews }) =>
      isSuperAdmin || (enabledViews.includes('design-module') && can('design-module:view')),
  },
];

/**
 * Returns the best route to navigate the user to.
 * Falls back to '/' (project selector) when no module is accessible.
 */
export function resolveAccessibleRoute(ctx: AccessibleRouteContext): string {
  if (ctx.canAccessHome) return '/home';

  const first = MODULE_ORDER.find((m) => m.isAccessible(ctx));
  return first ? first.route : '/';
}
