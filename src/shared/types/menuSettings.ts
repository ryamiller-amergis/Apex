export type MenuItemKey =
  | 'calendar'
  | 'planning'
  | 'cloudcost'
  | 'backlog'
  | 'my-work'
  | 'standup';

export const CONFIGURABLE_MENU_ITEMS: { key: MenuItemKey; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'planning', label: 'Planning' },
  { key: 'cloudcost', label: 'Cloud Cost' },
  { key: 'backlog', label: 'Interview' },
  { key: 'my-work', label: 'My Work' },
  { key: 'standup', label: 'Standup' },
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
