import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MenuItemKey, ProjectMenuConfig } from '../../shared/types/menuSettings';
import type {
  CreateProjectAccessRequestsRequest,
  PlatformAdminAccessRequest,
  PlatformAdminAccessRequestsResponse,
  PlatformAdminAssignmentsResponse,
  PlatformAdminMenuConfigResponse,
  PlatformAdminProject,
  PlatformAdminProjectsResponse,
  PlatformAdminUser,
  PlatformAdminUsersResponse,
  ProjectAccessRequest,
  ProjectAccessRequestCatalogResponse,
  ProjectAccessRequestsResponse,
  ProjectAccessRequestStatus,
  ProjectAssignmentGroup,
  SetProjectAssignmentsRequest,
} from '../../shared/types/platformAdmin';

export const platformAdminQueryKeys = {
  projects: ['platform-admin', 'projects'] as const,
  assignments: ['platform-admin', 'assignments'] as const,
  assignment: (project: string | null) => ['platform-admin', 'assignments', project] as const,
  users: ['platform-admin', 'users'] as const,
  accessRequests: (status: ProjectAccessRequestStatus | 'all' = 'pending') => ['platform-admin', 'access-requests', status] as const,
  menuSettings: ['platform-admin', 'menu-settings'] as const,
  menuSetting: (project: string | null) => ['platform-admin', 'menu-settings', project] as const,
};

export const projectAccessRequestQueryKeys = {
  catalog: ['project-access-requests', 'catalog'] as const,
  mine: ['project-access-requests', 'me'] as const,
};

async function platformAdminFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers?.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export function usePlatformAdminProjects() {
  return useQuery<PlatformAdminProject[]>({
    queryKey: platformAdminQueryKeys.projects,
    queryFn: async () => {
      const data = await platformAdminFetch<PlatformAdminProjectsResponse>('/api/platform-admin/projects');
      return data.projects;
    },
    staleTime: 60_000,
  });
}

export function usePlatformAdminAssignments() {
  return useQuery<ProjectAssignmentGroup[]>({
    queryKey: platformAdminQueryKeys.assignments,
    queryFn: async () => {
      const data = await platformAdminFetch<PlatformAdminAssignmentsResponse>('/api/platform-admin/assignments');
      return data.assignments;
    },
    staleTime: 60_000,
  });
}

export function usePlatformAdminAssignment(project: string | null) {
  return useQuery<ProjectAssignmentGroup>({
    queryKey: platformAdminQueryKeys.assignment(project),
    queryFn: () => platformAdminFetch<ProjectAssignmentGroup>(`/api/platform-admin/assignments/${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 60_000,
  });
}

export function usePlatformAdminUsers() {
  return useQuery<PlatformAdminUser[]>({
    queryKey: platformAdminQueryKeys.users,
    queryFn: async () => {
      const data = await platformAdminFetch<PlatformAdminUsersResponse>('/api/platform-admin/users');
      return data.users;
    },
    staleTime: 60_000,
  });
}

export function useSetPlatformAdminAssignments() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { project: string } & SetProjectAssignmentsRequest>({
    mutationFn: ({ project, userIds }) =>
      platformAdminFetch<void>(`/api/platform-admin/assignments/${encodeURIComponent(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds }),
      }),
    onSuccess: (_data, { project }) => {
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.projects });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.assignments });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.assignment(project) });
      queryClient.invalidateQueries({ queryKey: ['ado-projects'] });
    },
  });
}

export function useRequestableProjectCatalog(enabled = true) {
  return useQuery<PlatformAdminProject[]>({
    queryKey: projectAccessRequestQueryKeys.catalog,
    queryFn: async () => {
      const data = await platformAdminFetch<ProjectAccessRequestCatalogResponse>('/api/project-access-requests/catalog');
      return data.projects;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useMyProjectAccessRequests(enabled = true) {
  return useQuery<ProjectAccessRequest[]>({
    queryKey: projectAccessRequestQueryKeys.mine,
    queryFn: async () => {
      const data = await platformAdminFetch<ProjectAccessRequestsResponse>('/api/project-access-requests/me');
      return data.requests;
    },
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateProjectAccessRequests() {
  const queryClient = useQueryClient();
  return useMutation<ProjectAccessRequest[], Error, CreateProjectAccessRequestsRequest>({
    mutationFn: async ({ projects }) => {
      const data = await platformAdminFetch<ProjectAccessRequestsResponse>('/api/project-access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects }),
      });
      return data.requests;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectAccessRequestQueryKeys.catalog });
      queryClient.invalidateQueries({ queryKey: projectAccessRequestQueryKeys.mine });
    },
  });
}

export function usePlatformAdminAccessRequests(status: ProjectAccessRequestStatus | 'all' = 'pending') {
  return useQuery<PlatformAdminAccessRequest[]>({
    queryKey: platformAdminQueryKeys.accessRequests(status),
    queryFn: async () => {
      const params = new URLSearchParams({ status });
      const data = await platformAdminFetch<PlatformAdminAccessRequestsResponse>(`/api/platform-admin/access-requests?${params.toString()}`);
      return data.requests;
    },
    staleTime: 30_000,
  });
}

export function useApproveProjectAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation<PlatformAdminAccessRequest, Error, { requestId: string }>({
    mutationFn: ({ requestId }) =>
      platformAdminFetch<PlatformAdminAccessRequest>(`/api/platform-admin/access-requests/${encodeURIComponent(requestId)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: (_request, { requestId }) => {
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.accessRequests() });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.accessRequests('all') });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.assignments });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.projects });
      queryClient.invalidateQueries({ queryKey: ['ado-projects'] });
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'assignments'] });
      queryClient.invalidateQueries({ queryKey: ['platform-admin', 'access-requests', requestId] });
    },
  });
}

export function useRejectProjectAccessRequest() {
  const queryClient = useQueryClient();
  return useMutation<PlatformAdminAccessRequest, Error, { requestId: string }>({
    mutationFn: ({ requestId }) =>
      platformAdminFetch<PlatformAdminAccessRequest>(`/api/platform-admin/access-requests/${encodeURIComponent(requestId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.accessRequests() });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.accessRequests('all') });
    },
  });
}

export function usePlatformAdminMenuConfigs() {
  return useQuery<ProjectMenuConfig[]>({
    queryKey: platformAdminQueryKeys.menuSettings,
    queryFn: async () => {
      const data = await platformAdminFetch<PlatformAdminMenuConfigResponse>('/api/platform-admin/menu-settings');
      return data.configs;
    },
    staleTime: 60_000,
  });
}

export function usePlatformAdminMenuConfig(project: string | null) {
  return useQuery<ProjectMenuConfig>({
    queryKey: platformAdminQueryKeys.menuSetting(project),
    queryFn: () => platformAdminFetch<ProjectMenuConfig>(`/api/platform-admin/menu-settings/${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 60_000,
  });
}

export function useSetPlatformAdminMenuConfig() {
  const queryClient = useQueryClient();
  return useMutation<ProjectMenuConfig, Error, { project: string; enabledViews: MenuItemKey[] }>({
    mutationFn: ({ project, enabledViews }) =>
      platformAdminFetch<ProjectMenuConfig>(`/api/platform-admin/menu-settings/${encodeURIComponent(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabledViews }),
      }),
    onSuccess: (_data, { project }) => {
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.projects });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.menuSettings });
      queryClient.invalidateQueries({ queryKey: platformAdminQueryKeys.menuSetting(project) });
      queryClient.invalidateQueries({ queryKey: ['menu-config', project] });
    },
  });
}
