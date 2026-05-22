import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDesignDocResponse,
  CreateInterviewResponse,
  CreatePrdResponse,
  DesignDoc,
  DesignDocStatus,
  DesignDocSummary,
  Interview,
  InterviewStatus,
  InterviewSummary,
  Prd,
  PrdStatus,
  PrdSummary,
  ReviewDesignDocRequest,
  ReviewPrdRequest,
  ReviewPrdResponse,
} from '../../shared/types/interview';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ── Interview queries ──────────────────────────────────────────────────────────

export function useInterviewList(filters?: { status?: InterviewStatus; project?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<InterviewSummary[]>({
    queryKey: ['interviews', filters],
    queryFn: () => apiFetch(`/api/interviews${qs}`),
    staleTime: 30_000,
  });
}

export function useInterview(id: string | null) {
  return useQuery<Interview>({
    queryKey: ['interview', id],
    queryFn: () => apiFetch(`/api/interviews/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function usePrdList(filters?: { status?: PrdStatus; project?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<PrdSummary[]>({
    queryKey: ['prds', filters],
    queryFn: () => apiFetch(`/api/interviews/prds${qs}`),
    staleTime: 30_000,
  });
}

export function usePrd(id: string | null) {
  return useQuery<Prd>({
    queryKey: ['prd', id],
    queryFn: () => apiFetch(`/api/interviews/prds/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data?.content === '' ? 5_000 : false,
  });
}

// ── Design Doc queries ────────────────────────────────────────────────────────

export function useDesignDocList(filters?: { status?: DesignDocStatus; project?: string }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<DesignDocSummary[]>({
    queryKey: ['design-docs', filters],
    queryFn: () => apiFetch(`/api/interviews/design-docs${qs}`),
    staleTime: 30_000,
  });
}

export function useDesignDocsByPrd(prdId: string | null | undefined) {
  return useQuery<DesignDocSummary[]>({
    queryKey: ['design-docs', { prdId }],
    queryFn: () => apiFetch(`/api/interviews/design-docs?prdId=${prdId}`),
    enabled: !!prdId,
    staleTime: 30_000,
  });
}

export function useDesignDoc(id: string | null) {
  return useQuery<DesignDoc>({
    queryKey: ['design-doc', id],
    queryFn: () => apiFetch(`/api/interviews/design-docs/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      if (d.status === 'interviewing') return 10_000;
      return (d.designContent === '' || d.techSpecContent === '' || d.assumptionsContent === '') ? 5_000 : false;
    },
  });
}

// ── Interview mutations ────────────────────────────────────────────────────────

export function useCreateInterview() {
  const qc = useQueryClient();
  return useMutation<CreateInterviewResponse, Error, { project: string; repo: string; title?: string; chatThreadId: string }>({
    mutationFn: (body) =>
      apiFetch('/api/interviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['interviews'] }),
  });
}

export function useUpdateInterviewStatus() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; status: InterviewStatus }>({
    mutationFn: ({ id, status }) =>
      apiFetch(`/api/interviews/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['interviews'] });
      qc.invalidateQueries({ queryKey: ['interview', id] });
    },
  });
}

export function useUpdateInterviewTitle() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: string; title: string }>({
    mutationFn: ({ id, title }) =>
      apiFetch(`/api/interviews/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['interviews'] });
      qc.invalidateQueries({ queryKey: ['interview', id] });
    },
  });
}

export function useDeleteInterview() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch(`/api/interviews/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['interviews'] }),
  });
}

export function useDeletePrd() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (prdId) => apiFetch(`/api/interviews/prds/${prdId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prds'] });
      qc.invalidateQueries({ queryKey: ['interviews'] });
    },
  });
}

// ── PRD mutations ─────────────────────────────────────────────────────────────

export function useCreatePrd() {
  const qc = useQueryClient();
  return useMutation<CreatePrdResponse, Error, { interviewId: string; chatThreadId: string; title?: string }>({
    mutationFn: ({ interviewId, ...body }) =>
      apiFetch(`/api/interviews/${interviewId}/prds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prds'] });
      qc.invalidateQueries({ queryKey: ['interviews'] });
    },
  });
}

export function useUpdatePrdContent() {
  const qc = useQueryClient();
  return useMutation<void, Error, { prdId: string; content: string }>({
    mutationFn: ({ prdId, content }) =>
      apiFetch(`/api/interviews/prds/${prdId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }),
    onSuccess: (_data, { prdId }) => qc.invalidateQueries({ queryKey: ['prd', prdId] }),
  });
}

export function useSubmitPrd() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/submit`, { method: 'POST' }),
    onSuccess: (_data, prdId) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

export function useWithdrawPrd() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/withdraw`, { method: 'POST' }),
    onSuccess: (_data, prdId) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

export function useReviewPrd() {
  const qc = useQueryClient();
  return useMutation<ReviewPrdResponse, Error, { prdId: string } & ReviewPrdRequest>({
    mutationFn: ({ prdId, ...body }) =>
      apiFetch(`/api/interviews/prds/${prdId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { prdId }) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useSyncPrd() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; content: string }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/sync`, { method: 'POST' }),
    onSuccess: (_data, prdId) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

// ── Design Doc mutations ──────────────────────────────────────────────────────

export function useCreateDesignDoc() {
  const qc = useQueryClient();
  return useMutation<CreateDesignDocResponse, Error, { prdId: string }>({
    mutationFn: ({ prdId }) =>
      apiFetch(`/api/interviews/prds/${prdId}/design-docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useUpdateDesignDocContent() {
  const qc = useQueryClient();
  return useMutation<void, Error, { designDocId: string; designContent?: string; techSpecContent?: string; assumptionsContent?: string }>({
    mutationFn: ({ designDocId, ...body }) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { designDocId }) => qc.invalidateQueries({ queryKey: ['design-doc', designDocId] }),
  });
}

export function useSubmitDesignDoc() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/submit`, { method: 'POST' }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useWithdrawDesignDoc() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/withdraw`, { method: 'POST' }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useReviewDesignDoc() {
  const qc = useQueryClient();
  return useMutation<void, Error, { designDocId: string } & ReviewDesignDocRequest>({
    mutationFn: ({ designDocId, ...body }) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { designDocId }) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useDeleteDesignDoc() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useSyncDesignDoc() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; designContent: string | null; techSpecContent: string | null; assumptionsContent: string | null }, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/sync`, { method: 'POST' }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useGenerateDesignDoc() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/generate`, { method: 'POST' }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}
