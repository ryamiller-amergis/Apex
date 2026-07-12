import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PdfSession,
  CreateSessionResponse,
  UploadFilesResponse,
  PageManifestEntry,
} from '../../shared/types/pdf';

export interface PdfUploadProgress {
  phase: 'uploading' | 'processing';
  percent: number;
}

export type PdfApiError = Error & { code?: string; status?: number };

interface UploadPdfFilesVariables {
  sessionId: string;
  files: File[];
  onProgress?: (progress: PdfUploadProgress) => void;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`) as PdfApiError;
    err.code = body.error?.code;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function usePdfSession(sessionId: string | null) {
  return useQuery<PdfSession, PdfApiError>({
    queryKey: ['pdf-session', sessionId],
    queryFn: () => apiFetch(`/api/pdf/sessions/${sessionId}`),
    enabled: !!sessionId,
    staleTime: 5_000,
    retry: (failureCount, error) =>
      error.status !== 404 && error.status !== 410 && failureCount < 3,
    refetchInterval: (query) => {
      const jobs = query.state.data?.conversionJobs ?? [];
      return jobs.some((job) => job.status === 'queued' || job.status === 'processing')
        ? 2_000
        : false;
    },
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
  return useMutation<CreateSessionResponse, PdfApiError, { projectId?: string }>({
    mutationFn: (body) =>
      apiFetch('/api/pdf/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session'] });
      queryClient.invalidateQueries({ queryKey: ['pdf-sessions-active'] });
    },
  });
}

export function useUploadPdfFiles() {
  const queryClient = useQueryClient();
  return useMutation<UploadFilesResponse, PdfApiError, UploadPdfFilesVariables>({
    mutationFn: async ({ sessionId, files, onProgress }) => {
      const formData = new FormData();
      for (const f of files) {
        formData.append('files', f);
      }

      return new Promise<UploadFilesResponse>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', `/api/pdf/sessions/${sessionId}/upload`);
        request.withCredentials = true;

        request.upload.onprogress = (event) => {
          if (!event.lengthComputable) return;
          onProgress?.({
            phase: 'uploading',
            percent: Math.round((event.loaded / event.total) * 100),
          });
        };
        request.upload.onload = () => {
          onProgress?.({ phase: 'processing', percent: 100 });
        };
        request.onerror = () => {
          reject(new Error('Upload failed. Check your connection and retry.'));
        };
        request.onload = () => {
          let body: any = {};
          try {
            body = request.responseText ? JSON.parse(request.responseText) : {};
          } catch {
            // The status fallback below provides a useful error for invalid JSON.
          }

          if (request.status >= 200 && request.status < 300) {
            resolve(body as UploadFilesResponse);
            return;
          }

          const error = new Error(
            body.error?.message ?? body.error ?? `HTTP ${request.status}`,
          ) as PdfApiError;
          error.code = body.error?.code;
          error.status = request.status;
          reject(error);
        };

        onProgress?.({ phase: 'uploading', percent: 0 });
        request.send(formData);
      });
    },
    onSuccess: (_data, { sessionId }) =>
      queryClient.invalidateQueries({ queryKey: ['pdf-session', sessionId] }),
  });
}

export function useRemovePdfFile() {
  const queryClient = useQueryClient();
  return useMutation<void, PdfApiError, { sessionId: string; fileId: string }>({
    mutationFn: async ({ sessionId, fileId }) => {
      const res = await fetch(`/api/pdf/sessions/${sessionId}/files/${fileId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`) as PdfApiError;
        err.code = body.error?.code;
        err.status = res.status;
        throw err;
      }
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session', sessionId] });
    },
  });
}

export function useUpdateManifest() {
  const queryClient = useQueryClient();
  return useMutation<
    { pageCount: number; updatedAt: string },
    Error & { code?: string },
    { sessionId: string; manifest: PageManifestEntry[] }
  >({
    mutationFn: ({ sessionId, manifest }) =>
      apiFetch(`/api/pdf/sessions/${sessionId}/manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest }),
      }),
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session', sessionId] });
    },
  });
}
