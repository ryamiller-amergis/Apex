import { describe, it, expect } from '@jest/globals';
import {
  CONFIGURABLE_MENU_ITEMS,
  type MenuItemKey,
  type ProjectMenuConfig,
  type UpsertProjectMenuConfigRequest,
} from '../../shared/types/menuSettings';

describe('menuSettings shared types', () => {
  it('CONFIGURABLE_MENU_ITEMS has exactly 10 entries', () => {
    expect(CONFIGURABLE_MENU_ITEMS).toHaveLength(10);
  });

  it('contains the expected keys in order', () => {
    const keys = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);
    expect(keys).toEqual([
      'calendar',
      'planning',
      'cloudcost',
      'backlog',
      'my-work',
      'standup',
      'ui-lab',
      'feature-requests',
      'pdf-tools',
      'ai-cost',
    ]);
  });

  it('contains the expected labels matching AppHeader nav items', () => {
    const labels = CONFIGURABLE_MENU_ITEMS.map((item) => item.label);
    expect(labels).toEqual([
      'Calendar',
      'Planning',
      'Cloud Cost',
      'Interview',
      'My Work',
      'Standup',
      'UI Lab',
      'Feature Requests',
      'PDF Tools',
      'AI Cost Analytics',
    ]);
  });

  it('MenuItemKey union is exercised through the catalog keys', () => {
    const keys: MenuItemKey[] = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);
    expect(keys).toContain('calendar');
    expect(keys).toContain('planning');
    expect(keys).toContain('cloudcost');
    expect(keys).toContain('backlog');
    expect(keys).toContain('ui-lab');
    expect(keys).toContain('feature-requests');
  });

  it('ProjectMenuConfig shape is correctly typed', () => {
    const config: ProjectMenuConfig = {
      project: 'TestProject',
      enabledViews: ['calendar', 'backlog'],
      updatedBy: 'user@example.com',
    };
    expect(config.project).toBe('TestProject');
    expect(config.enabledViews).toEqual(['calendar', 'backlog']);
  });

  it('UpsertProjectMenuConfigRequest shape is correctly typed', () => {
    const req: UpsertProjectMenuConfigRequest = {
      enabledViews: ['planning', 'cloudcost'],
    };
    expect(req.enabledViews).toHaveLength(2);
  });
});
