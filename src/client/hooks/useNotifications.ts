import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AppNotification,
  NotificationPreference,
  UpsertNotificationPreferenceRequest,
  TeamsNotificationConfig,
} from '../../shared/types/notification';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function useNotifications(opts?: { limit?: number; offset?: number }) {
  return useQuery<AppNotification[]>({
    queryKey: ['notifications', opts],
    queryFn: () =>
      apiFetch(`/api/notifications?limit=${opts?.limit ?? 20}&offset=${opts?.offset ?? 0}`),
    staleTime: 30_000,
  });
}

export function useUnreadCount() {
  return useQuery<{ count: number }>({
    queryKey: ['notifications-unread-count'],
    queryFn: () => apiFetch('/api/notifications/unread-count'),
    staleTime: 30_000,
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/notifications/${id}/read`, { method: 'PATCH' }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previousLists = queryClient.getQueriesData<AppNotification[]>({ queryKey: ['notifications'] });
      queryClient.setQueriesData<AppNotification[]>({ queryKey: ['notifications'] }, (old) =>
        old?.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      const previousCount = queryClient.getQueryData<{ count: number }>(['notifications-unread-count']);
      if (previousCount && previousCount.count > 0) {
        queryClient.setQueryData(['notifications-unread-count'], { count: previousCount.count - 1 });
      }
      return { previousLists, previousCount };
    },
    onError: (_err, _id, context: any) => {
      if (context?.previousLists) {
        for (const [key, data] of context.previousLists) {
          queryClient.setQueryData(key, data);
        }
      }
      if (context?.previousCount) {
        queryClient.setQueryData(['notifications-unread-count'], context.previousCount);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

export function useMarkAllAsRead() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: () =>
      apiFetch('/api/notifications/read-all', { method: 'PATCH' }),
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['notifications'] });
      const previousLists = queryClient.getQueriesData<AppNotification[]>({ queryKey: ['notifications'] });
      queryClient.setQueriesData<AppNotification[]>({ queryKey: ['notifications'] }, (old) =>
        old?.map((n) => ({ ...n, read: true })),
      );
      const previousCount = queryClient.getQueryData<{ count: number }>(['notifications-unread-count']);
      queryClient.setQueryData(['notifications-unread-count'], { count: 0 });
      return { previousLists, previousCount };
    },
    onError: (_err, _vars, context: any) => {
      if (context?.previousLists) {
        for (const [key, data] of context.previousLists) {
          queryClient.setQueryData(key, data);
        }
      }
      if (context?.previousCount) {
        queryClient.setQueryData(['notifications-unread-count'], context.previousCount);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-unread-count'] });
    },
  });
}

export function useNotificationPreferences() {
  return useQuery<NotificationPreference[]>({
    queryKey: ['notification-preferences'],
    queryFn: () => apiFetch('/api/notifications/preferences'),
    staleTime: 60_000,
  });
}

export function useUpdateNotificationPreference() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, UpsertNotificationPreferenceRequest>({
    mutationFn: (body) =>
      apiFetch('/api/notifications/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
    },
  });
}

export function useTeamsNotificationConfig() {
  return useQuery<TeamsNotificationConfig>({
    queryKey: ['admin', 'app-settings', 'teamsNotifications'],
    queryFn: () => apiFetch('/api/admin/app-settings/teamsNotifications'),
    staleTime: 60_000,
  });
}

export function useUpdateTeamsNotificationConfig() {
  const queryClient = useQueryClient();
  return useMutation<TeamsNotificationConfig, Error, TeamsNotificationConfig>({
    mutationFn: (body) =>
      apiFetch('/api/admin/app-settings/teamsNotifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'app-settings', 'teamsNotifications'] });
    },
  });
}
