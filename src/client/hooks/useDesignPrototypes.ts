import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DesignPrototype,
  DesignPrototypeComment,
  DesignPrototypeSummary,
  DesignPrototypeStatus,
  DesignPrototypeStateName,
} from '../../shared/types/designPrototype';
import type { DocumentApproverAssignment } from '../../shared/types/approvals';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

const GENERATING_STATUSES: DesignPrototypeStatus[] = ['generating', 'regenerating'];

// ── Queries ─────────────────────────────────────────────────────────────────

export function useDesignPrototypeList(opts: {
  status?: string;
  project?: string;
  author?: string;
} = {}) {
  const params = new URLSearchParams();
  if (opts.status) params.set('status', opts.status);
  if (opts.project) params.set('project', opts.project);
  if (opts.author) params.set('author', opts.author);
  const qs = params.toString();

  return useQuery<DesignPrototypeSummary[]>({
    queryKey: ['design-prototypes', opts],
    queryFn: () => apiFetch(`/api/design-prototypes${qs ? `?${qs}` : ''}`),
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      if (!data) return false;
      const hasGenerating = data.some(p => GENERATING_STATUSES.includes(p.status));
      return hasGenerating ? 5_000 : false;
    },
  });
}

export function usePrototypeAssignments(prdId: string | null) {
  return useQuery<DocumentApproverAssignment[]>({
    queryKey: ['design-prototypes', 'assignments', prdId],
    queryFn: () => apiFetch(`/api/design-prototypes/prd/${prdId}/assignments`),
    enabled: !!prdId,
    staleTime: 10_000,
  });
}

export function usePrototypesForPrd(prdId: string | null) {
  return useQuery<DesignPrototypeSummary[]>({
    queryKey: ['design-prototypes', 'prd', prdId],
    queryFn: () => apiFetch(`/api/design-prototypes/prd/${prdId}`),
    enabled: !!prdId,
    staleTime: 15_000,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      if (!data) return false;
      const hasGenerating = data.some(p => GENERATING_STATUSES.includes(p.status));
      return hasGenerating ? 5_000 : false;
    },
  });
}

export function usePrototype(id: string | null) {
  return useQuery<DesignPrototype>({
    queryKey: ['design-prototype', id],
    queryFn: () => apiFetch(`/api/design-prototypes/${id}`),
    enabled: !!id,
    staleTime: 10_000,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = query.state.data?.status;
      if (!status) return false;
      return GENERATING_STATUSES.includes(status) ? 5_000 : false;
    },
  });
}

export function usePrototypeComments(prototypeId: string | null) {
  return useQuery<DesignPrototypeComment[]>({
    queryKey: ['design-prototype-comments', prototypeId],
    queryFn: () => apiFetch(`/api/design-prototypes/${prototypeId}/comments`),
    enabled: !!prototypeId,
    staleTime: 15_000,
  });
}

// ── Mutations ───────────────────────────────────────────────────────────────

export function useUpdatePrototypeHtml() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, html }: { id: string; html: string }) =>
      apiFetch(`/api/design-prototypes/${id}/html`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', variables.id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useRegeneratePrototype() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, feedback, targetStates }: { id: string; feedback: string; targetStates?: DesignPrototypeStateName[] }) =>
      apiFetch(`/api/design-prototypes/${id}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback, targetStates }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', variables.id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useRetryPrototype() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/design-prototypes/${id}/retry`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useResetPrototype() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/design-prototypes/${id}/reset`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useGeneratePrototypesForPrd() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; prototypeIds: string[] }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/design-prototypes/prd/${prdId}/generate`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useReviewPrototype() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, comment }: { id: string; action: 'approve' | 'revision_requested'; comment?: string }) =>
      apiFetch(`/api/design-prototypes/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, comment }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', variables.id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useReopenPrototype() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/design-prototypes/${id}/reopen`, { method: 'POST' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['design-prototype', id] });
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useAddPrototypeComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prototypeId, text, mockVersion, pinX, pinY }: {
      prototypeId: string;
      text: string;
      mockVersion: number;
      pinX?: number;
      pinY?: number;
    }) =>
      apiFetch<DesignPrototypeComment>(`/api/design-prototypes/${prototypeId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, mockVersion, pinX, pinY }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-prototype-comments', variables.prototypeId] });
    },
  });
}

export function useDeletePrototype() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiFetch(`/api/design-prototypes/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-prototypes'] });
    },
  });
}

export function useResolvePrototypeComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId }: { commentId: string; prototypeId: string }) =>
      apiFetch(`/api/design-prototypes/comments/${commentId}/resolve`, { method: 'POST' }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['design-prototype-comments', variables.prototypeId] });
    },
  });
}
