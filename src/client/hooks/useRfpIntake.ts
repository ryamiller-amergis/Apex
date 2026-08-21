import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateRfpCommentDTO,
  CreateRfpRequestDTO,
  RfpComment,
  RfpEvaluationChatMessage,
  RfpOwnerListResponse,
  RfpRequest,
  RfpRequestDetail,
  RfpSubmitAccessRequest,
} from '../../shared/types/rfpIntake';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
    (error as Error & { fields?: Record<string, string> }).fields = (body as { fields?: Record<string, string> }).fields;
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const RFP_INTAKE_QUERY_KEY = ['rfp-intake'] as const;

function mineKey(page: number) {
  return [...RFP_INTAKE_QUERY_KEY, 'mine', page] as const;
}

function detailKey(id: string) {
  return [...RFP_INTAKE_QUERY_KEY, 'detail', id] as const;
}

function shouldPollList(data: RfpOwnerListResponse | undefined): boolean {
  return Boolean(data?.items.some((item) => item.aiStatus === 'evaluating' || item.status === 'evaluating'));
}

export function useMyRfpRequests(enabled: boolean, page = 0) {
  return useQuery<RfpOwnerListResponse>({
    queryKey: mineKey(page),
    queryFn: () => apiFetch(`/api/rfp-intake/requests/mine?limit=50&offset=${page * 50}`),
    enabled,
    staleTime: 15_000,
    refetchInterval: (query) => (shouldPollList(query.state.data) ? 5_000 : false),
  });
}

export function useRfpRequestDetail(id: string | null, enabled: boolean) {
  return useQuery<RfpRequestDetail>({
    queryKey: detailKey(id ?? ''),
    queryFn: () => apiFetch(`/api/rfp-intake/requests/${id}`),
    enabled: enabled && Boolean(id),
    refetchInterval: (query) =>
      query.state.data?.aiStatus === 'evaluating' || query.state.data?.status === 'evaluating'
        ? 5_000
        : false,
  });
}

export interface SubmitRfpVariables {
  intake: CreateRfpRequestDTO;
  files: File[];
}

export function useSubmitRfpRequest() {
  const qc = useQueryClient();
  return useMutation<RfpRequest, Error, SubmitRfpVariables, { previous: RfpOwnerListResponse | undefined }>({
    onMutate: async (variables) => {
      await qc.cancelQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
      const previous = qc.getQueryData<RfpOwnerListResponse>(mineKey(0));
      const optimistic = {
        id: `optimistic-${Date.now()}`,
        title: variables.intake.title,
        status: 'evaluating' as const,
        aiStatus: 'evaluating' as const,
        currentVerdict: null,
        clarificationUsed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      qc.setQueryData<RfpOwnerListResponse>(mineKey(0), (old) => {
        if (!old) return { items: [optimistic], total: 1 };
        return { items: [optimistic, ...old.items], total: old.total + 1 };
      });
      return { previous };
    },
    mutationFn: async ({ intake, files }) => {
      if (files.length > 0) {
        const form = new FormData();
        form.append('title', intake.title);
        form.append('stakeholder', intake.stakeholder);
        form.append('request', intake.request);
        form.append('problem', intake.problem);
        form.append('audience', intake.audience);
        form.append('dataSensitivity', intake.dataSensitivity);
        form.append('existingSolution', intake.existingSolution);
        if (intake.advantage) form.append('advantage', intake.advantage);
        if (intake.constraints) form.append('constraints', intake.constraints);
        if (intake.requestType) form.append('requestType', intake.requestType);
        if (intake.requestType === 'change-existing' && intake.existingSystemStack) {
          form.append('existingSystemStack', intake.existingSystemStack);
        }
        for (const file of files) form.append('attachments', file);
        return apiFetch<RfpRequest>('/api/rfp-intake/requests', { method: 'POST', body: form });
      }
      return apiFetch<RfpRequest>('/api/rfp-intake/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intake),
      });
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        qc.setQueryData(mineKey(0), context.previous);
      } else {
        qc.setQueryData(mineKey(0), { items: [], total: 0 });
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
    },
  });
}

export function useClarifyRfpRequest() {
  const qc = useQueryClient();
  return useMutation<RfpRequest, Error, { id: string; intake: CreateRfpRequestDTO }>({
    mutationFn: ({ id, intake }) =>
      apiFetch(`/api/rfp-intake/requests/${id}/clarify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(intake),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: detailKey(variables.id) });
    },
  });
}

export function useAddRfpComment() {
  const qc = useQueryClient();
  return useMutation<RfpComment, Error, { id: string } & CreateRfpCommentDTO>({
    mutationFn: ({ id, ...body }) =>
      apiFetch(`/api/rfp-intake/requests/${id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: detailKey(variables.id) });
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
    },
  });
}

function evaluationChatKey(id: string) {
  return [...RFP_INTAKE_QUERY_KEY, 'evaluation-chat', id] as const;
}

export function useRfpEvaluationChat(id: string | null, enabled: boolean) {
  return useQuery<RfpEvaluationChatMessage[]>({
    queryKey: evaluationChatKey(id ?? ''),
    queryFn: () => apiFetch(`/api/rfp-intake/requests/${id}/evaluation-chat`),
    enabled: enabled && Boolean(id),
  });
}

export function useAskRfpEvaluationChat() {
  const qc = useQueryClient();
  return useMutation<RfpEvaluationChatMessage[], Error, { id: string; message: string }>({
    mutationFn: ({ id, message }) =>
      apiFetch(`/api/rfp-intake/requests/${id}/evaluation-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      }),
    onSuccess: (created, variables) => {
      qc.setQueryData<RfpEvaluationChatMessage[]>(evaluationChatKey(variables.id), (current) => [
        ...(current ?? []),
        ...created,
      ]);
    },
  });
}

function submitAccessKey() {
  return [...RFP_INTAKE_QUERY_KEY, 'submit-access', 'me'] as const;
}

export function useMyRfpSubmitAccessRequests(enabled: boolean) {
  return useQuery<RfpSubmitAccessRequest[]>({
    queryKey: submitAccessKey(),
    queryFn: async () => {
      const data = await apiFetch<{ requests: RfpSubmitAccessRequest[] }>(
        '/api/rfp-intake/submit-access-requests/me',
      );
      return data.requests;
    },
    enabled,
    staleTime: 15_000,
  });
}

export function useCreateRfpSubmitAccessRequest() {
  const qc = useQueryClient();
  return useMutation<RfpSubmitAccessRequest | null, Error, void>({
    mutationFn: async () => {
      const data = await apiFetch<{ request: RfpSubmitAccessRequest | null }>(
        '/api/rfp-intake/submit-access-requests',
        { method: 'POST' },
      );
      return data.request;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: submitAccessKey() });
    },
  });
}
