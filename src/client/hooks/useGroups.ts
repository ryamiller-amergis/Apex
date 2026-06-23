import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AppGroup,
  GroupWithMembers,
  GroupMember,
  CreateGroupRequest,
  UpdateGroupRequest,
} from '../../shared/types/groups';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers?.get('content-length') === '0') {
    return undefined as unknown as T;
  }
  return res.json() as Promise<T>;
}

export function useGroups(project?: string) {
  return useQuery<AppGroup[]>({
    queryKey: ['admin', 'groups', project],
    queryFn: () => {
      const url = project
        ? `/api/admin/groups?project=${encodeURIComponent(project)}`
        : '/api/admin/groups';
      return apiFetch<AppGroup[]>(url);
    },
    staleTime: 60_000,
  });
}

export function useGroupsWithMembers(project?: string) {
  return useQuery<GroupWithMembers[]>({
    queryKey: ['admin', 'groups', 'withMembers', project],
    queryFn: () => {
      const url = project
        ? `/api/admin/groups?withMembers=true&project=${encodeURIComponent(project)}`
        : '/api/admin/groups?withMembers=true';
      return apiFetch<GroupWithMembers[]>(url);
    },
    staleTime: 60_000,
  });
}

export function useGroupWithMembers(groupId: string | null) {
  return useQuery<GroupWithMembers>({
    queryKey: ['admin', 'groups', groupId],
    queryFn: () => apiFetch<GroupWithMembers>(`/api/admin/groups/${groupId}`),
    enabled: !!groupId,
    staleTime: 30_000,
  });
}

export function useCreateGroup(project?: string) {
  const qc = useQueryClient();
  return useMutation<AppGroup, Error, CreateGroupRequest>({
    mutationFn: (body) =>
      apiFetch<AppGroup>('/api/admin/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, project }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

export function useSeedDefaultGroups() {
  const qc = useQueryClient();
  return useMutation<GroupWithMembers[], Error, string>({
    mutationFn: (project) =>
      apiFetch<GroupWithMembers[]>(`/api/admin/groups/seed/${encodeURIComponent(project)}`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
    },
  });
}

export function useUpdateGroup() {
  const qc = useQueryClient();
  return useMutation<AppGroup, Error, { id: string } & UpdateGroupRequest>({
    mutationFn: ({ id, ...body }) =>
      apiFetch<AppGroup>(`/api/admin/groups/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'groups'] }),
  });
}

export function useDeleteGroup() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch<void>(`/api/admin/groups/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'groups'] }),
  });
}

export function useSetGroupMembers() {
  const qc = useQueryClient();
  return useMutation<GroupMember[], Error, { groupId: string; userIds: string[] }>({
    mutationFn: ({ groupId, userIds }) =>
      apiFetch<GroupMember[]>(`/api/admin/groups/${groupId}/members`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['admin', 'groups'] });
      qc.invalidateQueries({ queryKey: ['admin', 'groups', vars.groupId] });
    },
  });
}
