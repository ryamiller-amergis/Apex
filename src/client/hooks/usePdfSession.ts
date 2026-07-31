import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  PdfSession,
  CreateSessionResponse,
  UploadFilesResponse,
  PageManifestEntry,
  UpdateManifestResponse,
  OverlayTextBox,
  ReplaceOverlaysResponse,
  ReplaceFormValuesResponse,
  ReplaceSignatureOverlaysResponse,
  UploadSignatureResponse,
  PdfTextFormValue,
  PdfSignatureOverlay,
} from '../../shared/types/pdf';
import { apexProjectHeaders, getSelectedApexProject } from '../utils/apiFetch';

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

async function pdfApiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: apexProjectHeaders(options?.headers),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(
      body.error?.message ?? body.error ?? `HTTP ${res.status}`
    ) as PdfApiError;
    err.code = body.error?.code;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function usePdfSession(sessionId: string | null, userId = '') {
  return useQuery<PdfSession, PdfApiError>({
    queryKey: ['pdf-session', userId, sessionId],
    queryFn: () => pdfApiFetch(`/api/pdf/sessions/${sessionId}`),
    enabled: !!sessionId && !!userId,
    staleTime: 5_000,
    retry: (failureCount, error) =>
      error.status !== 403 &&
      error.status !== 404 &&
      error.status !== 410 &&
      failureCount < 3,
    refetchInterval: (query) => {
      const jobs = query.state.data?.conversionJobs ?? [];
      return jobs.some(
        (job) => job.status === 'queued' || job.status === 'processing'
      )
        ? 2_000
        : false;
    },
  });
}

export function useActivePdfSessions(userId = '') {
  return useQuery<PdfSession[]>({
    queryKey: ['pdf-sessions-active', userId],
    queryFn: () => pdfApiFetch('/api/pdf/sessions'),
    enabled: !!userId,
    staleTime: 10_000,
  });
}

export function useCreatePdfSession(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    CreateSessionResponse,
    PdfApiError,
    { projectId?: string; replaceSessionId?: string }
  >({
    mutationFn: (body) =>
      pdfApiFetch('/api/pdf/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pdf-session', userId] });
      queryClient.invalidateQueries({
        queryKey: ['pdf-sessions-active', userId],
      });
    },
  });
}

export function useClosePdfSession(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<void, PdfApiError, { sessionId: string }>({
    mutationFn: async ({ sessionId }) => {
      const res = await fetch(`/api/pdf/sessions/${sessionId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: apexProjectHeaders(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body.error?.message ?? body.error ?? `HTTP ${res.status}`
        ) as PdfApiError;
        err.code = body.error?.code;
        err.status = res.status;
        throw err;
      }
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: ['pdf-session', userId, sessionId],
      });
      queryClient.invalidateQueries({
        queryKey: ['pdf-sessions-active', userId],
      });
    },
  });
}

export function useUploadPdfFiles(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<UploadFilesResponse, PdfApiError, UploadPdfFilesVariables>(
    {
      mutationFn: async ({ sessionId, files, onProgress }) => {
        const formData = new FormData();
        for (const f of files) {
          formData.append('files', f);
        }

        return new Promise<UploadFilesResponse>((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open('POST', `/api/pdf/sessions/${sessionId}/upload`);
          request.withCredentials = true;

          const project = getSelectedApexProject();
          if (project) {
            request.setRequestHeader('X-Apex-Project', project);
          }

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
            reject(
              new Error('Upload failed. Check your connection and retry.')
            );
          };
          request.onload = () => {
            let body: any = {};
            try {
              body = request.responseText
                ? JSON.parse(request.responseText)
                : {};
            } catch {
              // The status fallback below provides a useful error for invalid JSON.
            }

            if (request.status >= 200 && request.status < 300) {
              resolve(body as UploadFilesResponse);
              return;
            }

            const error = new Error(
              body.error?.message ?? body.error ?? `HTTP ${request.status}`
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
        queryClient.invalidateQueries({
          queryKey: ['pdf-session', userId, sessionId],
        }),
    }
  );
}

export function useRemovePdfFile(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<void, PdfApiError, { sessionId: string; fileId: string }>({
    mutationFn: async ({ sessionId, fileId }) => {
      const res = await fetch(
        `/api/pdf/sessions/${sessionId}/files/${fileId}`,
        {
          method: 'DELETE',
          credentials: 'include',
          headers: apexProjectHeaders(),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(
          body.error?.message ?? body.error ?? `HTTP ${res.status}`
        ) as PdfApiError;
        err.code = body.error?.code;
        err.status = res.status;
        throw err;
      }
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({
        queryKey: ['pdf-session', userId, sessionId],
      });
    },
  });
}

export function useUpdateManifest(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    UpdateManifestResponse,
    Error & { code?: string },
    { sessionId: string; manifest: PageManifestEntry[] }
  >({
    mutationFn: ({ sessionId, manifest }) =>
      pdfApiFetch(`/api/pdf/sessions/${sessionId}/manifest`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest }),
      }),
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<PdfSession>(
        ['pdf-session', userId, sessionId],
        (session) =>
          session
            ? {
                ...session,
                textOverlays: data.textOverlays,
                updatedAt: data.updatedAt,
              }
            : session
      );
      queryClient.invalidateQueries({
        queryKey: ['pdf-session', userId, sessionId],
      });
    },
  });
}

export function useUpdateOverlays(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    ReplaceOverlaysResponse,
    PdfApiError,
    { sessionId: string; overlays: OverlayTextBox[] }
  >({
    mutationFn: ({ sessionId, overlays }) =>
      pdfApiFetch(`/api/pdf/sessions/${sessionId}/overlays`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlays }),
      }),
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<PdfSession>(
        ['pdf-session', userId, sessionId],
        (session) =>
          session
            ? {
                ...session,
                textOverlays: data.overlays,
                updatedAt: data.updatedAt,
              }
            : session
      );
    },
  });
}

export function useUpdateFormValues(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    ReplaceFormValuesResponse,
    PdfApiError,
    { sessionId: string; values: PdfTextFormValue[] }
  >({
    mutationFn: ({ sessionId, values }) =>
      pdfApiFetch(`/api/pdf/sessions/${sessionId}/form-values`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      }),
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<PdfSession>(
        ['pdf-session', userId, sessionId],
        (session) =>
          session
            ? {
                ...session,
                formFieldValues: data.values,
                updatedAt: data.updatedAt,
              }
            : session
      );
    },
  });
}

export function useUploadSignatureAsset(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    UploadSignatureResponse,
    PdfApiError,
    { sessionId: string; blob: Blob }
  >({
    mutationFn: async ({ sessionId, blob }) => {
      const formData = new FormData();
      formData.append('image', blob, 'signature.png');
      return pdfApiFetch<UploadSignatureResponse>(
        `/api/pdf/sessions/${sessionId}/signature-assets`,
        { method: 'POST', body: formData }
      );
    },
    onSuccess: (_data, { sessionId }) => {
      // Invalidate session so signatureState.assets reflects the new upload.
      void queryClient.invalidateQueries({ queryKey: ['pdf-session', userId, sessionId] });
    },
  });
}

export function useUpdateSignatureOverlays(userId = '') {
  const queryClient = useQueryClient();
  return useMutation<
    ReplaceSignatureOverlaysResponse,
    PdfApiError,
    { sessionId: string; overlays: PdfSignatureOverlay[] }
  >({
    mutationFn: ({ sessionId, overlays }) =>
      pdfApiFetch(`/api/pdf/sessions/${sessionId}/signature-overlays`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overlays }),
      }),
    onSuccess: (data, { sessionId }) => {
      queryClient.setQueryData<PdfSession>(
        ['pdf-session', userId, sessionId],
        (session) =>
          session
            ? {
                ...session,
                signatureState: {
                  ...session.signatureState,
                  overlays: data.overlays,
                },
                updatedAt: data.updatedAt,
              }
            : session
      );
    },
  });
}
