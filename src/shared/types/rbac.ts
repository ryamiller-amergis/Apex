// ── Core entity types — mirror the DB schema exactly ──────────────────────────

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

// ── Aggregate types — used in API responses ───────────────────────────────────

export interface RoleWithPermissions extends AppRole {
  /** Permission keys, e.g. ['admin:roles', 'chat:create'] */
  permissions: string[];
}

export interface UserWithRoles extends AppUser {
  /** Role names, e.g. ['admin', 'member'] */
  roles: string[];
}

// ── Request/response DTOs ─────────────────────────────────────────────────────

export interface AssignRoleRequest {
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
  userId: string;
  changelogUnread: boolean;
  showChangelogOnLogin: boolean;
}
