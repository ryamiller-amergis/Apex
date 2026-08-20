import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RfpHumanStatus,
  RfpMentionCandidate,
  RfpTriageDetail,
  RfpTriageListResponse,
  RfpVerdict,
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

export function useRfpTriageDetail(id: string | null, enabled: boolean) {
  return useQuery<RfpTriageDetail>({
    queryKey: triageDetailKey(id ?? ''),
    queryFn: () => apiFetch(`/api/rfp-intake/triage/requests/${id}`),
    enabled: enabled && Boolean(id),
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

export function useCanViewRfpTriage(isSuperAdmin: boolean) {
  const query = useQuery<{ permissions: string[] }>({
    queryKey: ['me', 'permissions', 'Apex', 'rfp-intake'],
    queryFn: () => apiFetch('/api/me/permissions?project=Apex'),
    staleTime: 60_000,
  });
  const permissions = query.data?.permissions ?? [];
  return isSuperAdmin
    || permissions.includes('rfp-intake:view')
    || permissions.includes('rfp-intake:manage');
}
