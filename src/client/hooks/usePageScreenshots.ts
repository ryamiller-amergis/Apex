import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageScreenshot } from '../../server/services/pageScreenshotService';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    if (res.status === 404) return undefined as T;
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function usePageScreenshot(route: string | undefined) {
  return useQuery<PageScreenshot | undefined>({
    queryKey: ['page-screenshot', route],
    queryFn: () =>
      route
        ? apiFetch(`/api/page-screenshots/by-route?route=${encodeURIComponent(route)}`)
        : undefined,
    enabled: !!route,
    staleTime: 60_000,
    retry: false,
  });
}

export function useUploadPageScreenshot() {
  const qc = useQueryClient();
  return useMutation<
    PageScreenshot,
    Error,
    { url: string; imageBase64: string; mediaType: string }
  >({
    mutationFn: ({ url, imageBase64, mediaType }) =>
      apiFetch('/api/page-screenshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, imageBase64, mediaType }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(['page-screenshot', data.route], data);
      qc.invalidateQueries({ queryKey: ['page-screenshots'] });
    },
  });
}

export function useDeletePageScreenshot() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; route: string }>({
    mutationFn: ({ id }) =>
      apiFetch(`/api/page-screenshots/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, variables) => {
      qc.setQueryData(['page-screenshot', variables.route], undefined);
      qc.invalidateQueries({ queryKey: ['page-screenshots'] });
    },
  });
}
