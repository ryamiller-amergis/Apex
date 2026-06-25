import { useState, useRef, useCallback, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  UiLabDesign,
  UiLabDesignSummary,
  UiLabComment,
  CreateUiLabDesignRequest,
  RegenerateUiLabDesignRequest,
  AddUiLabCommentRequest,
  UiLabStreamChunk,
} from '../../shared/types/uiLab';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const ACTIVE_STATUSES = ['generating', 'streaming'];

// ── List query (auto-polls while any design is generating/streaming) ──────────

export function useUiLabDesigns(project: string | null) {
  return useQuery<UiLabDesignSummary[]>({
    queryKey: ['ui-lab', 'designs', project],
    queryFn: () => apiFetch(`/api/ui-lab?project=${encodeURIComponent(project!)}`),
    enabled: !!project,
    staleTime: 10_000,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      if (!data) return false;
      const hasActive = data.some((d) => ACTIVE_STATUSES.includes(d.status));
      return hasActive ? 3_000 : false;
    },
  });
}

// ── Single design (auto-polls while active) ───────────────────────────────────

export function useUiLabDesign(id: string | null) {
  return useQuery<UiLabDesign>({
    queryKey: ['ui-lab', 'design', id],
    queryFn: () => apiFetch(`/api/ui-lab/${id}`),
    enabled: !!id,
    staleTime: 5_000,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      if (!data) return false;
      return ACTIVE_STATUSES.includes(data.status) ? 2_000 : false;
    },
  });
}

// ── Comments query ────────────────────────────────────────────────────────────

export function useUiLabComments(designId: string | null) {
  return useQuery<UiLabComment[]>({
    queryKey: ['ui-lab', 'comments', designId],
    queryFn: () => apiFetch(`/api/ui-lab/${designId}/comments`),
    enabled: !!designId,
    staleTime: 10_000,
  });
}

// ── Create mutation ───────────────────────────────────────────────────────────

export function useCreateUiLabDesign() {
  const qc = useQueryClient();
  return useMutation<UiLabDesign, Error, CreateUiLabDesignRequest & { project: string }>({
    mutationFn: (body) =>
      apiFetch('/api/ui-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['ui-lab', 'designs', vars.project] });
    },
  });
}

// ── Delete mutation ───────────────────────────────────────────────────────────

export function useDeleteUiLabDesign(project: string | null) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch(`/api/ui-lab/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ui-lab', 'designs', project] });
    },
  });
}

// ── Save HTML (manual boundary editor) ───────────────────────────────────────

export function useSaveUiLabHtml(designId: string | null) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (html) =>
      apiFetch(`/api/ui-lab/${designId}/html`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ui-lab', 'design', designId] });
    },
  });
}

// ── Add comment ───────────────────────────────────────────────────────────────

export function useAddUiLabComment(designId: string | null) {
  const qc = useQueryClient();
  return useMutation<UiLabComment, Error, AddUiLabCommentRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/ui-lab/${designId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ui-lab', 'comments', designId] });
    },
  });
}

// ── Resolve / reopen comment ─────────────────────────────────────────────────

export function useResolveUiLabComment(designId: string | null) {
  const qc = useQueryClient();
  return useMutation<void, Error, { commentId: string; reopen?: boolean }>({
    mutationFn: ({ commentId, reopen }) =>
      apiFetch(`/api/ui-lab/comments/${commentId}/${reopen ? 'reopen' : 'resolve'}`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ui-lab', 'comments', designId] });
    },
  });
}

// ── SSE streaming hook ────────────────────────────────────────────────────────

export type UiLabStreamPhase = 'idle' | 'streaming' | 'complete' | 'error';

export interface UiLabStreamState {
  phase: UiLabStreamPhase;
  streamedHtml: string;
  error: string | null;
  startStream: (designId: string, mode: 'generate' | 'regenerate', regenBody?: RegenerateUiLabDesignRequest) => void;
  cancelStream: () => void;
}

export function useUiLabStream(onComplete?: (designId: string) => void): UiLabStreamState {
  const [phase, setPhase] = useState<UiLabStreamPhase>('idle');
  const [streamedHtml, setStreamedHtml] = useState('');
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const activeDesignId = useRef<string | null>(null);
  const bufferRef = useRef('');
  const qc = useQueryClient();

  const cancelStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    xhrRef.current?.abort();
    xhrRef.current = null;
    setPhase('idle');
  }, []);

  const invalidateAfterComplete = useCallback((designId: string) => {
    qc.invalidateQueries({ queryKey: ['ui-lab', 'design', designId] });
    qc.invalidateQueries({ queryKey: ['ui-lab', 'designs'] });
    onComplete?.(designId);
  }, [qc, onComplete]);

  const startStream = useCallback(
    (designId: string, mode: 'generate' | 'regenerate', regenBody?: RegenerateUiLabDesignRequest) => {
      cancelStream();
      activeDesignId.current = designId;
      bufferRef.current = '';
      setStreamedHtml('');
      setError(null);
      setPhase('streaming');

      if (mode === 'generate') {
        // GET SSE for generation
        const es = new EventSource(`/api/ui-lab/${designId}/stream`, { withCredentials: true });
        esRef.current = es;

        es.onmessage = (e) => {
          try {
            const chunk = JSON.parse(e.data) as UiLabStreamChunk;
            if (chunk.type === 'token' && chunk.text) {
              bufferRef.current += chunk.text;
              setStreamedHtml(bufferRef.current);
            } else if (chunk.type === 'complete') {
              es.close();
              esRef.current = null;
              setPhase('complete');
              invalidateAfterComplete(designId);
            } else if (chunk.type === 'error') {
              es.close();
              esRef.current = null;
              setPhase('error');
              setError(chunk.error ?? 'Generation failed');
              invalidateAfterComplete(designId);
            }
          } catch {
            // ignore parse errors
          }
        };

        es.onerror = () => {
          es.close();
          esRef.current = null;
          setPhase('error');
          setError('Connection lost during generation');
          invalidateAfterComplete(designId);
        };
      } else {
        // POST + read SSE via XHR for regeneration (EventSource doesn't support POST)
        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;
        let cursor = 0;

        xhr.open('POST', `/api/ui-lab/${designId}/regenerate`);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.responseType = 'text';

        xhr.onprogress = () => {
          const newText = xhr.responseText.slice(cursor);
          cursor = xhr.responseText.length;

          const lines = newText.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const chunk = JSON.parse(line.slice(6)) as UiLabStreamChunk;
              if (chunk.type === 'token' && chunk.text) {
                bufferRef.current += chunk.text;
                setStreamedHtml(bufferRef.current);
              } else if (chunk.type === 'complete') {
                setPhase('complete');
                invalidateAfterComplete(designId);
              } else if (chunk.type === 'error') {
                setPhase('error');
                setError(chunk.error ?? 'Regeneration failed');
                invalidateAfterComplete(designId);
              }
            } catch {
              // skip
            }
          }
        };

        xhr.onload = () => {
          xhrRef.current = null;
        };

        xhr.onerror = () => {
          xhrRef.current = null;
          setPhase('error');
          setError('Connection lost during regeneration');
          invalidateAfterComplete(designId);
        };

        xhr.send(JSON.stringify(regenBody ?? { feedback: '' }));
      }
    },
    [cancelStream, invalidateAfterComplete],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
      xhrRef.current?.abort();
    };
  }, []);

  return { phase, streamedHtml, error, startStream, cancelStream };
}
