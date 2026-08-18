export type MenuItemKey =
  | 'calendar'
  | 'planning'
  | 'cloudcost'
  | 'backlog'
  | 'adr'
  | 'my-work'
  | 'standup'
  | 'ui-lab'
  | 'feature-requests'
  | 'pdf-tools'
  | 'ai-cost'
  | 'design-module'
  | 'load-tests'
  | 'diagrams'
  | 'work-board';

export const CONFIGURABLE_MENU_ITEMS: { key: MenuItemKey; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'planning', label: 'Planning' },
  { key: 'cloudcost', label: 'Cloud Cost' },
  { key: 'backlog', label: 'Interview' },
  { key: 'adr', label: 'ADR' },
  { key: 'my-work', label: 'My Work' },
  { key: 'standup', label: 'Standup' },
  { key: 'ui-lab', label: 'UI Lab' },
  { key: 'feature-requests', label: 'Apex Backlog' },
  { key: 'pdf-tools', label: 'PDF Assembly Tool' },
  { key: 'ai-cost', label: 'AI Cost Analytics' },
  { key: 'design-module', label: 'Design Module' },
  { key: 'load-tests', label: 'Load Tests' },
  { key: 'diagrams', label: 'Diagrams' },
  { key: 'work-board', label: 'Work Board' },
];

/** All configurable menu keys (includes opt-in-only keys such as Diagrams). */
export const ALL_MENU_VIEWS: MenuItemKey[] = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);

/**
 * Default enabled views when a project has no explicit menu config row.
 * Diagrams is opt-in (BR-011) and must not appear here.
 */
export const DEFAULT_ENABLED_MENU_VIEWS: MenuItemKey[] = ALL_MENU_VIEWS.filter(
  (key) => key !== 'diagrams',
);

export interface ProjectMenuConfig {
  project: string;
  enabledViews: MenuItemKey[];
  updatedBy?: string | null;
}

export interface UpsertProjectMenuConfigRequest {
  enabledViews: MenuItemKey[];
}
