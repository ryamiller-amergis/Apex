import type { MenuItemKey } from './menuSettings';

export interface UserProjectAssignment {
  id: string;
  userId: string;
  displayName: string;
  email: string;
  project: string;
  assignedBy?: string | null;
  assignedAt: string;
}

export interface ProjectAssignmentGroup {
  project: string;
  users: { userId: string; displayName: string; email: string }[];
}

export interface PlatformAdminUser {
  userId: string;
  displayName: string;
  email: string;
}

export interface PlatformAdminProject {
  id: string;
  name: string;
  description?: string;
}

export type ProjectAccessRequestStatus = 'pending' | 'approved' | 'rejected';

export interface ProjectAccessRequest {
  id: string;
  userId: string;
  project: string;
  status: ProjectAccessRequestStatus;
  requestedAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  reviewNote?: string | null;
}

export interface PlatformAdminAccessRequest extends ProjectAccessRequest {
  displayName: string;
  email: string;
}

export interface CreateProjectAccessRequestsRequest {
  projects: string[];
}

export interface SetProjectAssignmentsRequest {
  userIds: string[];
  pendingEmails?: string[];
}

export interface PlatformAdminAssignmentsResponse {
  assignments: ProjectAssignmentGroup[];
}

export interface PlatformAdminUsersResponse {
  users: PlatformAdminUser[];
}

export interface PlatformAdminGroup {
  id: string;
  name: string;
  project: string | null;
}

export interface PlatformAdminGroupsResponse {
  groups: PlatformAdminGroup[];
}

export interface PlatformAdminProjectsResponse {
  projects: PlatformAdminProject[];
}

export interface ProjectAccessRequestsResponse {
  requests: ProjectAccessRequest[];
}

export interface ProjectAccessRequestCatalogResponse {
  projects: PlatformAdminProject[];
}

export interface PlatformAdminAccessRequestsResponse {
  requests: PlatformAdminAccessRequest[];
}

export interface PlatformAdminMenuConfigResponse {
  configs: Array<{
    project: string;
    enabledViews: MenuItemKey[];
    updatedBy?: string | null;
  }>;
}

export interface PendingProjectAssignment {
  id: string;
  email: string;
  project: string;
  assignedBy?: string | null;
  assignedAt: string;
}

export interface PendingProjectAssignmentsResponse {
  pending: PendingProjectAssignment[];
}
