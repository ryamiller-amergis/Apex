/**
 * Curated, server-safe route catalog for Walkthrough step destinations and CTAs.
 *
 * Keep this list limited to stable, user-facing Apex pages. Entity-specific routes
 * are intentionally excluded because generated Walkthroughs must not invent IDs.
 */
export interface WalkthroughRouteCatalogEntry {
  route: string;
  label: string;
}

const ROUTE_ENTRIES: readonly WalkthroughRouteCatalogEntry[] = Object.freeze([
  Object.freeze({ route: '/home', label: 'Home' }),
  Object.freeze({ route: '/calendar', label: 'Calendar' }),
  Object.freeze({ route: '/planning', label: 'Planning' }),
  Object.freeze({
    route: '/planning/dev-stats',
    label: 'Planning — Developer stats',
  }),
  Object.freeze({ route: '/planning/qa', label: 'Planning — QA metrics' }),
  Object.freeze({
    route: '/planning/ai-analysis',
    label: 'Planning — AI analysis',
  }),
  Object.freeze({ route: '/planning/roadmap', label: 'Planning — Roadmap' }),
  Object.freeze({ route: '/planning/releases', label: 'Planning — Releases' }),
  Object.freeze({ route: '/cloud-cost', label: 'Cloud cost' }),
  Object.freeze({ route: '/backlog', label: 'Backlog' }),
  Object.freeze({
    route: '/backlog?tab=interviews',
    label: 'Interview — Interviews',
  }),
  Object.freeze({ route: '/backlog?tab=prds', label: 'Interview — PRDs' }),
  Object.freeze({
    route: '/backlog?tab=design-prototypes',
    label: 'Interview — Design prototypes',
  }),
  Object.freeze({
    route: '/backlog?tab=design-docs',
    label: 'Interview — Design documents',
  }),
  Object.freeze({ route: '/adr', label: 'Architecture decisions' }),
  Object.freeze({ route: '/notifications', label: 'Notifications' }),
  Object.freeze({ route: '/profile', label: 'Profile' }),
  Object.freeze({ route: '/admin', label: 'Project administration' }),
  Object.freeze({
    route: '/admin/roles',
    label: 'Project administration — Roles',
  }),
  Object.freeze({
    route: '/admin/users',
    label: 'Project administration — Users',
  }),
  Object.freeze({
    route: '/admin/groups',
    label: 'Project administration — Groups',
  }),
  Object.freeze({
    route: '/admin/project-settings',
    label: 'Project administration — Settings',
  }),
  Object.freeze({
    route: '/admin/notifications',
    label: 'Project administration — Notifications',
  }),
  Object.freeze({
    route: '/admin/load-test-targets',
    label: 'Project administration — Load test targets',
  }),
  Object.freeze({ route: '/my-work', label: 'My work' }),
  Object.freeze({ route: '/standup', label: 'Standup' }),
  Object.freeze({ route: '/standup-manage', label: 'Standup — Manage' }),
  Object.freeze({ route: '/standup-summary', label: 'Standup — Summary' }),
  Object.freeze({ route: '/feature-requests', label: 'Feature requests' }),
  Object.freeze({ route: '/ui-lab', label: 'UI Lab' }),
  Object.freeze({ route: '/pdf-tools', label: 'PDF tools' }),
  Object.freeze({ route: '/ai-cost', label: 'AI cost analytics' }),
  Object.freeze({ route: '/design-module', label: 'Design module' }),
  Object.freeze({ route: '/load-tests', label: 'Load tests' }),
]);

const BY_ROUTE = new Map(ROUTE_ENTRIES.map((entry) => [entry.route, entry]));

export function listWalkthroughRoutes(): readonly WalkthroughRouteCatalogEntry[] {
  return ROUTE_ENTRIES;
}

export function getWalkthroughRoute(
  route: string
): WalkthroughRouteCatalogEntry | undefined {
  return BY_ROUTE.get(route);
}

export function isWalkthroughRoute(route: unknown): route is string {
  return typeof route === 'string' && BY_ROUTE.has(route);
}
