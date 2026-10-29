import { describe, it, expect } from '@jest/globals';
import {
  ALL_MENU_VIEWS,
  CONFIGURABLE_MENU_ITEMS,
  DEFAULT_ENABLED_MENU_VIEWS,
  type MenuItemKey,
  type ProjectMenuConfig,
  type UpsertProjectMenuConfigRequest,
} from '../../shared/types/menuSettings';

describe('menuSettings shared types', () => {
  it('CONFIGURABLE_MENU_ITEMS has exactly 17 entries', () => {
    expect(CONFIGURABLE_MENU_ITEMS).toHaveLength(17);
  });

  it('contains the expected keys in order', () => {
    const keys = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);
    expect(keys).toEqual([
      'calendar',
      'planning',
      'cloudcost',
      'backlog',
      'adr',
      'my-work',
      'standup',
      'ui-lab',
      'feature-requests',
      'ai-cost',
      'design-module',
      'load-tests',
      'diagrams',
      'work-board',
      'playbooks',
      'builds',
      'mcp-servers',
    ]);
  });

  it('contains the expected labels matching AppHeader nav items', () => {
    const labels = CONFIGURABLE_MENU_ITEMS.map((item) => item.label);
    expect(labels).toEqual([
      'Calendar',
      'Planning',
      'Cloud Cost',
      'Interview',
      'ADR',
      'My Work',
      'Standup',
      'UI Lab',
      'Apex Backlog',
      'AI Cost Analytics',
      'Design Module',
      'Load Tests',
      'Diagrams',
      'Work Board',
      'Playbooks',
      'Builds',
      'MCP Servers',
    ]);
  });

  it('MenuItemKey union is exercised through the catalog keys', () => {
    const keys: MenuItemKey[] = CONFIGURABLE_MENU_ITEMS.map((item) => item.key);
    expect(keys).toContain('calendar');
    expect(keys).toContain('planning');
    expect(keys).toContain('cloudcost');
    expect(keys).toContain('backlog');
    expect(keys).toContain('adr');
    expect(keys).toContain('ui-lab');
    expect(keys).toContain('feature-requests');
    expect(keys).toContain('load-tests');
    expect(keys).toContain('diagrams');
    expect(keys).toContain('mcp-servers');
  });

  it('SC-1: integrations is configurable but omitted from DEFAULT_ENABLED_MENU_VIEWS', () => {
    expect(ALL_MENU_VIEWS).toContain('mcp-servers');
    expect(DEFAULT_ENABLED_MENU_VIEWS).not.toContain('mcp-servers');
    expect(DEFAULT_ENABLED_MENU_VIEWS).not.toContain('diagrams');
    expect(DEFAULT_ENABLED_MENU_VIEWS).toHaveLength(ALL_MENU_VIEWS.length - 3);
  });

  it('FEAT-002 VT-14: builds is configurable, labelled Builds, and opt-in', () => {
    expect(CONFIGURABLE_MENU_ITEMS).toContainEqual({ key: 'builds', label: 'Builds' });
    expect(ALL_MENU_VIEWS).toContain('builds');
    expect(DEFAULT_ENABLED_MENU_VIEWS).not.toContain('builds');
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
