import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Adr,
  AdrStatus,
  AdrSummary,
  CreateAdrRequest,
  CreateAdrResponse,
  GenerateAdrResponse,
  UpdateAdrRequest,
  AdrReviewerCandidate,
} from '../../shared/types/adr';
import type { DocumentApproverAssignment, DocumentOwnerApproval, OwnerApproveRequest } from '../../shared/types/approvals';
import type {
  CreateReviewCommentRequest,
  CreateReviewReplyRequest,
  ReviewCommentWithReplies,
} from '../../shared/types/reviewComments';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function useAdrs(filters?: { status?: AdrStatus; project?: string; author?: 'me' }) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  if (filters?.author) params.set('author', filters.author);
  const query = params.toString();
  return useQuery<AdrSummary[]>({
    queryKey: ['adrs', filters],
    queryFn: () => apiFetch(`/api/adr${query ? `?${query}` : ''}`),
    staleTime: 30_000,
    refetchInterval: (result) => result.state.data?.some((adr) => adr.status === 'generating') ? 5_000 : false,
  });
}

export function useAdr(id: string | null) {
  return useQuery<Adr>({
    queryKey: ['adr', id],
    queryFn: () => apiFetch(`/api/adr/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: (result) => result.state.data?.status === 'generating' ? 5_000 : false,
  });
}

export function useCreateAdr() {
  const queryClient = useQueryClient();
  return useMutation<CreateAdrResponse, Error, CreateAdrRequest>({
    mutationFn: (body) => apiFetch('/api/adr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adrs'] }),
  });
}

export function useGenerateAdr() {
  const queryClient = useQueryClient();
  return useMutation<GenerateAdrResponse, Error, string>({
    mutationFn: (id) => apiFetch(`/api/adr/${id}/generate`, { method: 'POST' }),
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
    },
  });
}

export function useUpdateAdr() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { id: string; changes: UpdateAdrRequest }>({
    mutationFn: ({ id, changes }) => apiFetch(`/api/adr/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    }),
    onSuccess: (_result, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
    },
  });
}

export function useDeleteAdr() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiFetch(`/api/adr/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adrs'] }),
  });
}

export function useApplyProposedAdr(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () => apiFetch(`/api/adr/${id}/apply-proposed`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
      void queryClient.invalidateQueries({ queryKey: ['adr-comments', id] });
    },
  });
}

export function useRejectProposedAdr(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () => apiFetch(`/api/adr/${id}/reject-proposed`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr', id] }),
  });
}

export function useAdrReviewerCandidates(project: string | null) {
  return useQuery<AdrReviewerCandidate[]>({
    queryKey: ['adr-reviewer-candidates', project],
    queryFn: () => apiFetch(`/api/adr/reviewer-candidates?project=${encodeURIComponent(project ?? '')}`),
    enabled: !!project,
    staleTime: 60_000,
  });
}

export function useAdrAssignments(id: string | null) {
  return useQuery<DocumentApproverAssignment[]>({
    queryKey: ['adr-assignments', id],
    queryFn: () => apiFetch(`/api/adr/${id}/assignments`),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function useAssignAdrReviewers(id: string) {
  const queryClient = useQueryClient();
  return useMutation<DocumentApproverAssignment[], Error, string[]>({
    mutationFn: (reviewerIds) => apiFetch(`/api/adr/${id}/assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewerIds }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adr-assignments', id] });
    },
  });
}

export function useRespondToAdrReview(id: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; approvalComplete: boolean }, Error, {
    status: 'approved' | 'revision_requested';
    comment?: string;
  }>({
    mutationFn: (body) => apiFetch(`/api/adr/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adr-assignments', id] });
    },
  });
}

export function useAdrOwnerApproval(id: string | null) {
  return useQuery<DocumentOwnerApproval | null>({
    queryKey: ['adr-owner-approval', id],
    queryFn: () => apiFetch(`/api/adr/${id}/owner-approval`),
    enabled: !!id,
    staleTime: 10_000,
  });
}

export function useRespondToAdrOwnerApproval(id: string) {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, OwnerApproveRequest>({
    mutationFn: (body) => apiFetch(`/api/adr/${id}/owner-approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['adr', id] });
      void queryClient.invalidateQueries({ queryKey: ['adrs'] });
      void queryClient.invalidateQueries({ queryKey: ['adr-owner-approval', id] });
    },
  });
}

export function useAdrComments(id: string | null) {
  return useQuery<ReviewCommentWithReplies[]>({
    queryKey: ['adr-comments', id],
    queryFn: () => apiFetch(`/api/review-comments/adr/${id}`),
    enabled: !!id,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useCreateAdrComment(id: string) {
  const queryClient = useQueryClient();
  return useMutation<ReviewCommentWithReplies, Error, CreateReviewCommentRequest>({
    mutationFn: (body) => apiFetch(`/api/review-comments/adr/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr-comments', id] }),
  });
}

export function useReplyToAdrComment(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { commentId: string } & CreateReviewReplyRequest>({
    mutationFn: ({ commentId, body }) => apiFetch(`/api/review-comments/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr-comments', id] }),
  });
}

function useAdrCommentAction(id: string, action: 'resolve' | 'reopen') {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (commentId) => apiFetch(`/api/review-comments/${commentId}/${action}`, { method: 'PATCH' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr-comments', id] }),
  });
}

export function useResolveAdrComment(id: string) {
  return useAdrCommentAction(id, 'resolve');
}

export function useReopenAdrComment(id: string) {
  return useAdrCommentAction(id, 'reopen');
}

export function useDeleteAdrComment(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (commentId) => apiFetch(`/api/review-comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr-comments', id] }),
  });
}

export function useFixAdrWithAi(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () => apiFetch(`/api/adr/${id}/fix-with-ai`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr', id] }),
  });
}

export function useFixAdrCommentWithAi(id: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { commentId: string }>({
    mutationFn: ({ commentId }) => apiFetch(`/api/adr/${id}/fix-comment-with-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commentId }),
    }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['adr', id] }),
  });
}
