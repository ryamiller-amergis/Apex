import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReviewCommentRequest,
  CreateReviewReplyRequest,
  ReviewDocumentType,
  ReviewCommentWithReplies,
} from '../../shared/types/reviewComments';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function useReviewComments(documentId: string | null, documentType: ReviewDocumentType) {
  return useQuery<ReviewCommentWithReplies[]>({
    queryKey: ['review-comments', documentType, documentId],
    queryFn: () => apiFetch(`/api/review-comments/${documentType}/${documentId}`),
    enabled: !!documentId,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });
}

export function useUnresolvedCommentCount(documentId: string | null, documentType: ReviewDocumentType) {
  return useQuery<ReviewCommentWithReplies[], Error, { count: number }>({
    queryKey: ['review-comments', documentType, documentId],
    queryFn: () => apiFetch(`/api/review-comments/${documentType}/${documentId}`),
    enabled: !!documentId,
    staleTime: 5_000,
    refetchInterval: 10_000,
    select: (comments) => ({ count: comments.filter(c => c.status === 'open').length }),
  });
}

export function useCreateComment(documentType: ReviewDocumentType, documentId: string | null) {
  const qc = useQueryClient();
  return useMutation<ReviewCommentWithReplies, Error, CreateReviewCommentRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/review-comments/${documentType}/${documentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['review-comments', documentType, documentId] });
    },
  });
}

export function useAddReply(commentId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, CreateReviewReplyRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/review-comments/${commentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['review-comments'] });
    },
  });
}

type CommentSnapshot = { queryKey: readonly unknown[]; data: ReviewCommentWithReplies[] };

async function optimisticStatusUpdate(
  qc: ReturnType<typeof useQueryClient>,
  commentId: string,
  status: 'open' | 'resolved',
  resolvedBy: string | null,
) {
  await qc.cancelQueries({ queryKey: ['review-comments'] });

  const snapshots: CommentSnapshot[] = [];

  const commentQueries = qc.getQueriesData<ReviewCommentWithReplies[]>({
    queryKey: ['review-comments'],
    predicate: (query) => !query.queryKey.includes('unresolved-count'),
  });

  for (const [queryKey, old] of commentQueries) {
    if (!Array.isArray(old)) continue;
    snapshots.push({ queryKey, data: old });
    qc.setQueryData<ReviewCommentWithReplies[]>(queryKey, old.map((c) =>
      c.id === commentId
        ? {
            ...c,
            status,
            resolvedBy,
            resolvedAt: status === 'resolved' ? new Date().toISOString() : null,
          }
        : c,
    ));
  }

  return { snapshots };
}

export function useResolveComment(currentUserId: string) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, { snapshots: CommentSnapshot[] }>({
    mutationFn: (commentId) =>
      apiFetch(`/api/review-comments/${commentId}/resolve`, { method: 'PATCH' }),
    onMutate: (commentId) =>
      optimisticStatusUpdate(qc, commentId, 'resolved', currentUserId),
    onError: (_err, _commentId, context) => {
      context?.snapshots.forEach(({ queryKey, data }) => qc.setQueryData(queryKey, data));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['review-comments'] });
    },
  });
}

export function useReopenComment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string, { snapshots: CommentSnapshot[] }>({
    mutationFn: (commentId) =>
      apiFetch(`/api/review-comments/${commentId}/reopen`, { method: 'PATCH' }),
    onMutate: (commentId) =>
      optimisticStatusUpdate(qc, commentId, 'open', null),
    onError: (_err, _commentId, context) => {
      context?.snapshots.forEach(({ queryKey, data }) => qc.setQueryData(queryKey, data));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['review-comments'] });
    },
  });
}

export function useDeleteComment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (commentId) =>
      apiFetch(`/api/review-comments/${commentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['review-comments'] });
    },
  });
}
