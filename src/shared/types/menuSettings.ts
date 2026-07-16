export type MenuItemKey =
  | 'calendar'
  | 'planning'
  | 'cloudcost'
  | 'backlog'
  | 'my-work'
  | 'standup'
  | 'ui-lab'
  | 'feature-requests'
  | 'pdf-tools'
  | 'ai-cost'
  | 'design-module';

export const CONFIGURABLE_MENU_ITEMS: { key: MenuItemKey; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'planning', label: 'Planning' },
  { key: 'cloudcost', label: 'Cloud Cost' },
  { key: 'backlog', label: 'Interview' },
  { key: 'my-work', label: 'My Work' },
  { key: 'standup', label: 'Standup' },
  { key: 'ui-lab', label: 'UI Lab' },
  { key: 'feature-requests', label: 'Apex Backlog' },
  { key: 'pdf-tools', label: 'PDF Assembly Tool' },
  { key: 'ai-cost', label: 'AI Cost Analytics' },
  { key: 'design-module', label: 'Design Module' },
];

/** Default enabled views when a project has no explicit menu config row. */
export const ALL_MENU_VIEWS: MenuItemKey[] = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);

export interface ProjectMenuConfig {
  project: string;
  enabledViews: MenuItemKey[];
  updatedBy?: string | null;
}

export interface UpsertProjectMenuConfigRequest {
  enabledViews: MenuItemKey[];
}
