import type { MenuItemKey } from './menuSettings';

/** Internal project token used for restricted (project-less UX) users. */
export const RESTRICTED_ACCESS_PROJECT = 'Apex';

/**
 * Accepts normal emails (`user@domain.tld`) and local dev-login personas (`user@localhost`).
 */
export function isRestrictedAccessEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return (
    /^[^\s@]+@localhost$/.test(normalized) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  );
}

/**
 * View-permission required for each configurable module.
 * Used by the Platform Admin UI to warn when a role lacks a selected module's permission.
 */
export const MODULE_VIEW_PERMISSIONS: Record<MenuItemKey, string> = {
  calendar: 'calendar:view',
  planning: 'planning:view',
  cloudcost: 'cost:view',
  backlog: 'interviews:view',
  adr: 'adr:view',
  'my-work': 'dev-workbench:view',
  standup: 'standup:participate',
  'ui-lab': 'ui-lab:view',
  'feature-requests': 'feature-requests:view',
  'pdf-tools': 'pdf-assembly:use',
  'ai-cost': 'analytics:ai-cost:view',
  'design-module': 'design-module:view',
  'load-tests': 'load-test:view',
  diagrams: 'diagram:view',
};

export interface RestrictedUserAccess {
  id: string;
  email: string;
  roleId: string;
  roleName: string;
  modules: MenuItemKey[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RestrictedAccessPayload {
  modules: MenuItemKey[];
  project: string;
}

export interface CreateRestrictedUserAccessRequest {
  email: string;
  roleId: string;
  modules: MenuItemKey[];
  enabled?: boolean;
}

export interface UpdateRestrictedUserAccessRequest {
  email?: string;
  roleId?: string;
  modules?: MenuItemKey[];
  enabled?: boolean;
}

export interface RestrictedUserAccessListResponse {
  entries: RestrictedUserAccess[];
}
