import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  isRfpProposalJobActive,
  type RfpArchitectureInput,
  type RfpGeneratedDraft,
  type RfpHumanStatus,
  type RfpMentionCandidate,
  type RfpRequest,
  type RfpTriageDetail,
  type RfpTriageListResponse,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';
import { RFP_INTAKE_QUERY_KEY } from './useRfpIntake';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function queueKey(params: { status: string; verdict: string; q: string; page: number }) {
  return [...RFP_INTAKE_QUERY_KEY, 'triage', params] as const;
}

function triageDetailKey(id: string) {
  return [...RFP_INTAKE_QUERY_KEY, 'triage-detail', id] as const;
}

export function useRfpQueue(params: {
  status: RfpHumanStatus | '';
  verdict: RfpVerdict | '';
  q: string;
  page: number;
  enabled: boolean;
}) {
  const search = new URLSearchParams({
    limit: '50',
    offset: String(params.page * 50),
  });
  if (params.status) search.set('status', params.status);
  if (params.verdict) search.set('verdict', params.verdict);
  if (params.q.trim()) search.set('q', params.q.trim());

  return useQuery<RfpTriageListResponse>({
    queryKey: queueKey(params),
    queryFn: () => apiFetch(`/api/rfp-intake/triage/requests?${search.toString()}`),
    enabled: params.enabled,
  });
}

const GENERATION_POLL_MS = 4_000;

export function useRfpTriageDetail(id: string | null, enabled: boolean) {
  return useQuery<RfpTriageDetail>({
    queryKey: triageDetailKey(id ?? ''),
    queryFn: () => apiFetch(`/api/rfp-intake/triage/requests/${id}`),
    enabled: enabled && Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.aiStatus === 'evaluating' || data?.status === 'evaluating') return 5_000;
      const status = data?.proposalGeneration?.status;
      return status && isRfpProposalJobActive(status) ? GENERATION_POLL_MS : false;
    },
  });
}

export function useRfpStatusTransition() {
  const qc = useQueryClient();
  return useMutation<RfpTriageDetail, Error, { id: string; target: RfpHumanStatus; note?: string }>({
    mutationFn: ({ id, target, note }) =>
      apiFetch(`/api/rfp-intake/triage/requests/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, note }),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
      qc.setQueryData(triageDetailKey(data.id), data);
    },
  });
}

function useTriageMutation<TVariables extends { id: string }>(
  request: (variables: TVariables) => { path: string; method: string; body?: unknown },
) {
  const qc = useQueryClient();
  return useMutation<RfpRequest, Error, TVariables>({
    mutationFn: (variables) => {
      const { path, method, body } = request(variables);
      return apiFetch(`/api/rfp-intake/triage/requests/${variables.id}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
    },
  });
}

export function useSubmitRfpReview() {
  return useTriageMutation<{ id: string; architecture: RfpArchitectureInput | null }>(({ architecture }) => ({
    path: '/submit-review',
    method: 'POST',
    body: { architecture },
  }));
}

export function useRetryRfpEvaluation() {
  return useTriageMutation<{ id: string }>(() => ({ path: '/retry', method: 'POST' }));
}

export function useRegenerateRfpProposal() {
  return useTriageMutation<{ id: string }>(() => ({ path: '/proposal/regenerate', method: 'POST' }));
}

export function useSaveRfpProposalDraft() {
  return useTriageMutation<{ id: string; draft: RfpGeneratedDraft }>(({ draft }) => ({
    path: '/proposal-draft',
    method: 'PUT',
    body: { draft },
  }));
}

export function usePublishRfpProposal() {
  return useTriageMutation<{ id: string; productOwnerId?: string }>(({ productOwnerId }) => ({
    path: '/proposal-draft/publish',
    method: 'POST',
    body: { productOwnerId },
  }));
}

export function useDeleteIntakeProject() {
  const qc = useQueryClient();
  return useMutation<RfpRequest, Error, { id: string }>({
    mutationFn: ({ id }) => apiFetch(`/api/rfp-intake/triage/requests/${id}/project`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ['platform-admin', 'projects'] });
      qc.invalidateQueries({ queryKey: ['ado-projects'] });
    },
  });
}

export function useRfpReopen() {
  const qc = useQueryClient();
  return useMutation<RfpTriageDetail, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiFetch(`/api/rfp-intake/triage/requests/${id}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
      qc.setQueryData(triageDetailKey(data.id), data);
    },
  });
}

export function useApplyRfpReviewerDecision() {
  const qc = useQueryClient();
  return useMutation<
    RfpRequest,
    Error,
    {
      id: string;
      verdict: RfpVerdict;
      rationale: string;
      constraintsToAdd?: string;
      sourceMessageIds?: string[];
      reevaluate?: boolean;
    }
  >({
    mutationFn: ({ id, ...body }) =>
      apiFetch(`/api/rfp-intake/triage/requests/${id}/reviewer-decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: RFP_INTAKE_QUERY_KEY });
    },
  });
}

export function useRfpAttachmentUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, files }: { id: string; files: File[] }) => {
      const form = new FormData();
      for (const file of files) form.append('attachments', file);
      return apiFetch(`/api/rfp-intake/requests/${id}/attachments`, { method: 'POST', body: form });
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: triageDetailKey(variables.id) });
      qc.invalidateQueries({ queryKey: [...RFP_INTAKE_QUERY_KEY, 'detail', variables.id] });
    },
  });
}

export function useRfpMentionCandidates(rfpId: string | null, q: string, enabled: boolean) {
  return useQuery<RfpMentionCandidate[]>({
    queryKey: [...RFP_INTAKE_QUERY_KEY, 'mentions', rfpId, q],
    queryFn: () =>
      apiFetch(`/api/rfp-intake/mentions/candidates?rfpId=${encodeURIComponent(rfpId ?? '')}&q=${encodeURIComponent(q)}`),
    enabled: enabled && Boolean(rfpId),
  });
}

export function useApexRfpPermissions() {
  return useQuery<{ permissions: string[] }>({
    queryKey: ['me', 'permissions', 'Apex', 'rfp-intake'],
    queryFn: () => apiFetch('/api/me/permissions?project=Apex'),
    staleTime: 60_000,
  });
}

export function useCanViewRfpTriage(isSuperAdmin: boolean) {
  const query = useApexRfpPermissions();
  const permissions = query.data?.permissions ?? [];
  return isSuperAdmin
    || permissions.includes('rfp-intake:view')
    || permissions.includes('rfp-intake:manage');
}

export function useCanSubmitRfp(isSuperAdmin: boolean) {
  const query = useApexRfpPermissions();
  const permissions = query.data?.permissions ?? [];
  return isSuperAdmin || permissions.includes('rfp-intake:submit');
}
