// ── Core entity types — mirror the DB schema exactly ──────────────────────────

import type { WhatsNewState } from './whatsNew';

export interface AppUser {
  oid: string;
  displayName: string | null;
  email: string | null;
  lastSeenAt: string | null; // ISO string (TIMESTAMPTZ)
}

export interface AppRole {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string; // ISO string
}

export interface AppPermission {
  id: string;
  key: string;
  description: string | null;
  category: string | null;
}

export interface AppUserRole {
  userId: string;
  roleId: string;
  assignedBy: string | null;
  assignedAt: string; // ISO string
}

export interface AppUserProjectRole {
  id: string;
  userId: string;
  project: string;
  roleId: string;
  assignedBy: string | null;
  assignedAt: string; // ISO string
}

// ── Aggregate types — used in API responses ───────────────────────────────────

export interface RoleWithPermissions extends AppRole {
  /** Permission keys, e.g. ['admin:roles', 'chat:create'] */
  permissions: string[];
}

export interface UserWithRoles extends AppUser {
  /** Role names, e.g. ['admin', 'member'] */
  roles: string[];
  /** Role names assigned for the requested project, when project-scoped. */
  projectRoles?: string[];
}

// ── Request/response DTOs ─────────────────────────────────────────────────────

export interface AssignRoleRequest {
  roleId: string;
}

export interface AssignProjectRoleRequest {
  project: string;
  roleId: string;
}

export interface RemoveProjectRoleRequest {
  project: string;
  roleId: string;
}

export interface UpdateRolePermissionsRequest {
  permissionIds: string[];
}

export interface CreateRoleRequest {
  name: string;
  description?: string;
  permissionIds?: string[];
}

export interface UpdateRoleRequest {
  name?: string;
  description?: string;
  isDefault?: boolean;
}

// ── Client-side permissions context (returned by /api/me/permissions) ─────────

export interface MyPermissionsResponse {
  permissions: string[];
  roles: string[];
  groups: string[];
  userId: string;
  isSuperAdmin: boolean;
  /** @deprecated Prefer `whatsNew.unread` — kept for one compatibility window. */
  changelogUnread: boolean;
  /** @deprecated Prefer `whatsNew.currentVersion`. */
  currentChangelogVersion: string;
  /** @deprecated Prefer `whatsNew.lastSeenVersion`. */
  lastSeenChangelogVersion: string | null;
  /** @deprecated Prefer `whatsNew.showOnLogin`. */
  showChangelogOnLogin: boolean;
  betaAnnouncementDismissed: boolean;
  /** Unified What's New evaluation (FEAT-006). Optional during compatibility window. */
  whatsNew?: WhatsNewState;
}

export interface UpdatePreferencesRequest {
  /** Legacy adapter — server resolves to the current valid bundled version. */
  markChangelogRead?: boolean;
  /** Must equal the current valid bundled release when supplied. */
  lastSeenVersion?: string;
  showChangelogOnLogin?: boolean;
  dismissBetaAnnouncement?: boolean;
}
