import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AppPermission,
  CreateRoleRequest,
  MyPermissionsResponse,
  RoleWithPermissions,
  UpdateRolePermissionsRequest,
  UpdateRoleRequest,
  UserWithRoles,
} from '../../shared/types/rbac';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Current-user hooks ────────────────────────────────────────────────────────

export function useMyPermissions() {
  const query = useQuery<MyPermissionsResponse>({
    queryKey: ['me', 'permissions'],
    queryFn: () => apiFetch<MyPermissionsResponse>('/api/me/permissions'),
    staleTime: 60_000,
  });
  const permissions = query.data?.permissions ?? [];
  const roles = query.data?.roles ?? [];
  return {
    ...query,
    permissions,
    roles,
    isAdmin: roles.includes('admin'),
    can: (key: string) => permissions.includes(key),
  };
}

// ── Admin query hooks ─────────────────────────────────────────────────────────

export function useRoles() {
  return useQuery<RoleWithPermissions[]>({
    queryKey: ['admin', 'roles'],
    queryFn: () => apiFetch<RoleWithPermissions[]>('/api/admin/roles'),
    staleTime: 60_000,
  });
}

export function usePermissions() {
  return useQuery<AppPermission[]>({
    queryKey: ['admin', 'permissions'],
    queryFn: () => apiFetch<AppPermission[]>('/api/admin/permissions'),
    staleTime: 5 * 60_000,
  });
}

export function useUsers() {
  return useQuery<UserWithRoles[]>({
    queryKey: ['admin', 'users'],
    queryFn: () => apiFetch<UserWithRoles[]>('/api/admin/users'),
    staleTime: 30_000,
  });
}

// ── Admin mutation hooks ──────────────────────────────────────────────────────

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation<RoleWithPermissions, Error, CreateRoleRequest>({
    mutationFn: (body) =>
      apiFetch<RoleWithPermissions>('/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'roles'] }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation<RoleWithPermissions, Error, { id: string } & UpdateRoleRequest>({
    mutationFn: ({ id, ...body }) =>
      apiFetch<RoleWithPermissions>(`/api/admin/roles/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'roles'] }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch<void>(`/api/admin/roles/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'roles'] }),
  });
}

export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string } & UpdateRolePermissionsRequest>({
    mutationFn: ({ id, ...body }) =>
      apiFetch<void>(`/api/admin/roles/${id}/permissions`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'roles'] }),
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation<void, Error, { oid: string; roleId: string }>({
    mutationFn: ({ oid, roleId }) =>
      apiFetch<void>(`/api/admin/users/${oid}/roles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}

export function useRemoveRole() {
  const qc = useQueryClient();
  return useMutation<void, Error, { oid: string; roleId: string }>({
    mutationFn: ({ oid, roleId }) =>
      apiFetch<void>(`/api/admin/users/${oid}/roles/${roleId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });
}
