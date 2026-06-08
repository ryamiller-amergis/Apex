export type MenuItemKey = 'calendar' | 'planning' | 'cloudcost' | 'backlog';

export const CONFIGURABLE_MENU_ITEMS: { key: MenuItemKey; label: string }[] = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'planning', label: 'Planning' },
  { key: 'cloudcost', label: 'Cloud Cost' },
  { key: 'backlog', label: 'Interview' },
];

export interface ProjectMenuConfig {
  project: string;
  enabledViews: MenuItemKey[];
  updatedBy?: string | null;
}

export interface UpsertProjectMenuConfigRequest {
  enabledViews: MenuItemKey[];
}
