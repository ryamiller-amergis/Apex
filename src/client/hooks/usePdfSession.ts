import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PdfSession,
  CreateSessionResponse,
  UploadFilesResponse,
} from '../../shared/types/pdf';

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body.error?.code;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function usePdfSession(sessionId: string | null) {
  return useQuery<PdfSession>({
    queryKey: ['pdf-session', sessionId],
    queryFn: () => apiFetch(`/api/pdf/sessions/${sessionId}`),
    enabled: !!sessionId,
    staleTime: 5_000,
  });
}

export function useActivePdfSessions() {
  return useQuery<PdfSession[]>({
    queryKey: ['pdf-sessions-active'],
    queryFn: () => apiFetch('/api/pdf/sessions'),
    staleTime: 10_000,
  });
}

export function useCreatePdfSession() {
  const queryClient = useQueryClient();
  return useMutation<CreateSessionResponse, Error & { code?: string }, { projectId?: string }>({
    mutationFn: (body) =>
      apiFetch('/api/pdf/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session'] });
    },
  });
}

export function useUploadPdfFiles() {
  const queryClient = useQueryClient();
  return useMutation<UploadFilesResponse, Error, { sessionId: string; files: File[] }>({
    mutationFn: async ({ sessionId, files }) => {
      const formData = new FormData();
      for (const f of files) {
        formData.append('files', f);
      }
      return apiFetch(`/api/pdf/sessions/${sessionId}/upload`, {
        method: 'POST',
        body: formData,
      });
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session', sessionId] });
    },
  });
}
