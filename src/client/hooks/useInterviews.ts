import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ActiveUser,
  CreateDesignDocResponse,
  CreateInterviewResponse,
  CreatePrdAdoItemsRequest,
  CreatePrdAdoItemsResponse,
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
  TestCaseCoverageSummary,
  TestCaseRecord,
} from '../../shared/types/interview';
import type {
  DocumentApproverAssignment,
  DocumentOwnerApproval,
  OwnerApprovalDocumentType,
  OwnerApproveRequest,
  SubmitDesignDocForReviewRequest,
  SubmitForReviewRequest,
} from '../../shared/types/approvals';
import type { ApproverPoolResponse } from '../../shared/types/projectSettings';
import type { ScreenInventoryRoute } from '../../shared/types/designSystem';
import type { GroupWithMembers } from '../../shared/types/groups';

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

export function useInterviewList(filters?: {
  status?: InterviewStatus;
  project?: string;
  author?: 'me';
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  if (filters?.author) params.set('author', filters.author);
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

export function usePrdList(filters?: {
  status?: PrdStatus;
  project?: string;
  author?: 'me';
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  if (filters?.author) params.set('author', filters.author);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<PrdSummary[]>({
    queryKey: ['prds', filters],
    queryFn: () => apiFetch(`/api/interviews/prds${qs}`),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.some((prd) => prd.latestTestCase?.status === 'generating')
        ? 5_000
        : false;
    },
  });
}

export function useScreenInventoryRoutes(enabled = true) {
  return useQuery<ScreenInventoryRoute[]>({
    queryKey: ['screen-inventory-routes'],
    queryFn: () => apiFetch('/api/interviews/screen-inventory'),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function usePrd(id: string | null) {
  return useQuery<Prd>({
    queryKey: ['prd', id],
    queryFn: () => apiFetch(`/api/interviews/prds/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      if (data.status === 'generating' && data.content === '') return 5_000;
      if (data.status === 'validating') return 5_000;
      if (data.fixBaseline) return 5_000;
      if (data.fixCommentId && data.proposedContent == null && data.proposedBacklogJson == null) {
        return 5_000;
      }
      return false;
    },
  });
}

export function usePrdTestCases(prdId: string | null) {
  return useQuery<TestCaseRecord | null>({
    queryKey: ['prd-test-cases', prdId],
    queryFn: () => apiFetch(`/api/interviews/prds/${prdId}/test-cases`),
    enabled: !!prdId,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      return !data || data.status === 'generating' ? 5_000 : false;
    },
  });
}

export function useGenerateTestCases() {
  const qc = useQueryClient();
  return useMutation<{ started: boolean }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/test-cases/generate`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useRecalculateTestCaseCoverage() {
  const qc = useQueryClient();
  return useMutation<
    { coverageSummary: TestCaseCoverageSummary },
    Error,
    string
  >({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/test-cases/recalculate`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

// ── Design Doc queries ────────────────────────────────────────────────────────

const TRANSIENT_DOC_STATUSES: DesignDocStatus[] = ['generating', 'validating'];

export function useDesignDocList(filters?: {
  status?: DesignDocStatus;
  project?: string;
  author?: 'me';
}) {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.project) params.set('project', filters.project);
  if (filters?.author) params.set('author', filters.author);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return useQuery<DesignDocSummary[]>({
    queryKey: ['design-docs', filters],
    queryFn: () => apiFetch(`/api/interviews/design-docs${qs}`),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return data.some((d) => TRANSIENT_DOC_STATUSES.includes(d.status)) ? 5_000 : false;
    },
  });
}

export function useDesignDocsByPrd(prdId: string | null | undefined) {
  return useQuery<DesignDocSummary[]>({
    queryKey: ['design-docs', { prdId }],
    queryFn: () => apiFetch(`/api/interviews/design-docs?prdId=${prdId}`),
    enabled: !!prdId,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return data.some((d) => TRANSIENT_DOC_STATUSES.includes(d.status)) ? 5_000 : false;
    },
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
      if (d.status === 'validating') return 10_000;
      if (
        d.status === 'generating' &&
        (d.designContent === '' ||
          d.techSpecContent === '' ||
          d.assumptionsContent === '')
      )
        return 5_000;
      if (d.fixBaseline) return 5_000;
      if (
        d.fixCommentId &&
        d.proposedDesignContent == null &&
        d.proposedTechSpecContent == null &&
        d.proposedAssumptionsContent == null
      ) {
        return 5_000;
      }
      return false;
    },
  });
}

// ── Active users query ─────────────────────────────────────────────────────────

export function useActiveUsers(project?: string) {
  return useQuery<ActiveUser[]>({
    queryKey: ['active-users', project],
    queryFn: () => {
      const url = project
        ? `/api/interviews/active-users?project=${encodeURIComponent(project)}`
        : '/api/interviews/active-users';
      return apiFetch(url);
    },
    staleTime: 60_000,
  });
}

export function useInterviewGroupsWithMembers(project: string | null) {
  return useQuery<GroupWithMembers[]>({
    queryKey: ['interview-groups', project],
    queryFn: () => {
      const url = project
        ? `/api/interviews/groups-with-members?project=${encodeURIComponent(project)}`
        : '/api/interviews/groups-with-members';
      return apiFetch(url);
    },
    enabled: !!project,
    staleTime: 60_000,
  });
}

// ── Interview mutations ────────────────────────────────────────────────────────

// ── Approver queries ──────────────────────────────────────────────────────────

export function useAvailableApproverPool(
  project: string,
  documentType: 'prd' | 'design_doc' | 'design_prototype' | 'test_case',
  excludeSelf = true
) {
  const qs = excludeSelf ? '?excludeSelf=true' : '';
  return useQuery<ApproverPoolResponse>({
    queryKey: ['available-approver-pool', project, documentType, excludeSelf],
    queryFn: () =>
      apiFetch(
        `/api/interviews/approver-pool/${encodeURIComponent(project)}/${documentType}${qs}`
      ),
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useAvailableApprovers(
  project: string,
  documentType: 'prd' | 'design_doc',
  excludeSelf = true
) {
  const qs = excludeSelf ? '?excludeSelf=true' : '';
  return useQuery<{ userId: string; displayName: string }[]>({
    queryKey: ['available-approvers', project, documentType, excludeSelf],
    queryFn: () =>
      apiFetch(
        `/api/interviews/available-approvers/${encodeURIComponent(project)}/${documentType}${qs}`
      ),
    enabled: !!project,
    staleTime: 30_000,
  });
}

export function useReassignApprovers() {
  const qc = useQueryClient();
  return useMutation<
    DocumentApproverAssignment[],
    Error,
    {
      documentId: string;
      documentType: 'prd' | 'design_doc';
      approverUserIds: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
      qaApproverIds?: string[];
    }
  >({
    mutationFn: ({
      documentId,
      documentType,
      approverUserIds,
      designDocApproverIds,
      designPrototypeApproverIds,
      qaApproverIds,
    }) => {
      const endpoint =
        documentType === 'prd'
          ? `/api/interviews/prds/${documentId}/assignments`
          : `/api/interviews/design-docs/${documentId}/assignments`;
      return apiFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approverUserIds,
          ...(documentType === 'prd' && designDocApproverIds !== undefined
            ? { designDocApproverIds }
            : {}),
          ...(documentType === 'prd' && designPrototypeApproverIds !== undefined
            ? { designPrototypeApproverIds }
            : {}),
          ...(documentType === 'prd' && qaApproverIds !== undefined
            ? { qaApproverIds }
            : {}),
        }),
      });
    },
    onSuccess: (_data, { documentId, documentType }) => {
      qc.invalidateQueries({
        queryKey: ['document-assignments', documentId, documentType],
      });
      qc.invalidateQueries({ queryKey: ['prd', documentId] });
    },
  });
}

export function useDocumentAssignments(
  documentId: string | null,
  documentType: 'prd' | 'design_doc' | 'design_prototype' | 'test_case'
) {
  const endpoint =
    documentType === 'prd' || documentType === 'test_case' || documentType === 'design_prototype'
      ? `/api/interviews/prds/${documentId}/assignments?documentType=${documentType}`
      : `/api/interviews/design-docs/${documentId}/assignments`;
  return useQuery<DocumentApproverAssignment[]>({
    queryKey: ['document-assignments', documentId, documentType],
    queryFn: () => apiFetch(endpoint),
    enabled: !!documentId,
    staleTime: 10_000,
    refetchInterval: 10_000,
  });
}

// ── Interview mutations (continued) ──────────────────────────────────────────

export function useCreateInterview() {
  const qc = useQueryClient();
  return useMutation<
    CreateInterviewResponse,
    Error,
    {
      project: string;
      repo: string;
      title?: string;
      chatThreadId: string;
      model?: string;
      skillSettingsId?: string;
      prdOwnerId?: string;
      designDocOwnerId?: string;
      designPrototypeOwnerId?: string;
      testCaseOwnerId?: string;
      prdApproverIds?: string[];
      designDocApproverIds?: string[];
      designPrototypeApproverIds?: string[];
      testCaseApproverIds?: string[];
    }
  >({
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
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prds'] });
      qc.invalidateQueries({ queryKey: ['interviews'] });
    },
  });
}

// ── PRD mutations ─────────────────────────────────────────────────────────────

export function useCreatePrd() {
  const qc = useQueryClient();
  return useMutation<
    CreatePrdResponse,
    Error,
    { interviewId: string; chatThreadId: string; title?: string; model?: string }
  >({
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
    onSuccess: (_data, { prdId }) =>
      qc.invalidateQueries({ queryKey: ['prd', prdId] }),
  });
}

export function useUpdatePrdBacklog() {
  const qc = useQueryClient();
  return useMutation<void, Error, { prdId: string; backlogData: unknown }>({
    mutationFn: ({ prdId, backlogData }) =>
      apiFetch(`/api/interviews/prds/${prdId}/backlog`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backlogData }),
      }),
    onSuccess: (_data, { prdId }) =>
      qc.invalidateQueries({ queryKey: ['prd', prdId] }),
  });
}

export function useSubmitPrd() {
  const qc = useQueryClient();
  return useMutation<void, Error, { prdId: string } & SubmitForReviewRequest>({
    mutationFn: ({ prdId, ...body }) =>
      apiFetch(`/api/interviews/prds/${prdId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { prdId }) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
      qc.invalidateQueries({ queryKey: ['document-assignments', prdId] });
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

export function useReopenPrd() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/reopen`, { method: 'POST' }),
    onSuccess: (_data, prdId) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

export function useReviewPrd() {
  const qc = useQueryClient();
  return useMutation<
    ReviewPrdResponse,
    Error,
    { prdId: string } & ReviewPrdRequest
  >({
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

export function useReviewTestCases() {
  const qc = useQueryClient();
  return useMutation<
    { approved: boolean },
    Error,
    { prdId: string; status: 'approved' }
  >({
    mutationFn: ({ prdId, ...body }) =>
      apiFetch(`/api/interviews/prds/${prdId}/test-cases/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { prdId }) => {
      qc.invalidateQueries({
        queryKey: ['document-assignments', prdId, 'test_case'],
      });
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prds'] });
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
  return useMutation<
    void,
    Error,
    {
      designDocId: string;
      designContent?: string;
      techSpecContent?: string;
      assumptionsContent?: string;
    }
  >({
    mutationFn: ({ designDocId, ...body }) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { designDocId }) =>
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] }),
  });
}

export function useSubmitDesignDoc() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { designDocId: string } & SubmitDesignDocForReviewRequest
  >({
    mutationFn: ({ designDocId, ...body }) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { designDocId }) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
      qc.invalidateQueries({ queryKey: ['document-assignments', designDocId] });
    },
  });
}

export function useWithdrawDesignDoc() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/withdraw`, {
        method: 'POST',
      }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useReviewDesignDoc() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    { designDocId: string } & ReviewDesignDocRequest
  >({
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
      apiFetch(`/api/interviews/design-docs/${designDocId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useSyncDesignDoc() {
  const qc = useQueryClient();
  return useMutation<
    {
      ok: boolean;
      designContent: string | null;
      techSpecContent: string | null;
      assumptionsContent: string | null;
    },
    Error,
    string
  >({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/sync`, {
        method: 'POST',
      }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useRetryGenerateDesignDoc() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; threadId: string }, Error, string>({
    mutationFn: (designDocId) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/retry-generate`, {
        method: 'POST',
      }),
    onSuccess: (_data, designDocId) => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useDesignDocValidation(docId: string | null) {
  return useQuery({
    queryKey: ['design-doc-validation', docId],
    queryFn: () =>
      apiFetch<{
        validationThreadId: string | null;
        validationScore: number | null;
        validationScorecard: unknown | null;
        validationPhase: string | null;
      }>(`/api/interviews/design-docs/${docId}/validation`),
    enabled: !!docId,
    refetchInterval: (query) => {
      const score = (query.state.data as any)?.validationScore;
      return score === null || score === undefined ? 10_000 : false;
    },
  });
}

export function useCreateValidationThread() {
  const qc = useQueryClient();
  return useMutation<{ threadId: string }, Error, string>({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/validation-thread`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-doc-validation', docId] });
    },
  });
}

export function useCancelValidation() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/validation/cancel`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-docs'] });
      qc.removeQueries({ queryKey: ['validation-report', docId] });
    },
  });
}

export function useRefreshValidation() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; score: number; is_ready: boolean },
    Error,
    string
  >({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/validation/refresh`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-doc-validation', docId] });
      void qc.invalidateQueries({ queryKey: ['validation-report', docId] });
    },
  });
}

export function useMarkValidationReady() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/validation/mark-ready`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useFixValidation() {
  const qc = useQueryClient();
  return useMutation<{ threadId: string }, Error, string>({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/fix-validation`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}

export function useAcceptFixValidation() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (docId) =>
      apiFetch(`/api/interviews/design-docs/${docId}/fix-validation/accept`, {
        method: 'POST',
      }),
    onSuccess: (_data, docId) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', docId] });
      void qc.invalidateQueries({ queryKey: ['design-docs'] });
      void qc.invalidateQueries({ queryKey: ['design-doc-validation', docId] });
      qc.removeQueries({ queryKey: ['validation-report', docId] });
    },
  });
}

export function useRevertDesignDocSection() {
  const qc = useQueryClient();
  return useMutation<
    void,
    Error,
    {
      designDocId: string;
      designContent?: string;
      techSpecContent?: string;
      assumptionsContent?: string;
    }
  >({
    mutationFn: ({ designDocId, ...body }) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { designDocId }) => {
      void qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
    },
  });
}

export function useValidationReport(
  docId: string | null,
  validationThreadId: string | null | undefined,
  docStatus?: string
) {
  return useQuery<
    { markdown: string | null; still_validating?: boolean },
    Error
  >({
    queryKey: ['validation-report', docId],
    queryFn: () =>
      apiFetch(`/api/interviews/design-docs/${docId!}/validation/report`),
    enabled: !!docId && !!validationThreadId && docStatus === 'validating',
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.data?.markdown) return false;
      if (docStatus === 'validating') return 10_000;
      return false;
    },
  });
}

// ── PRD Validation Hooks ──────────────────────────────────────────────────────

export function usePrdValidationReport(
  prdId: string | null,
  validationThreadId: string | null | undefined,
  prdStatus?: string
) {
  return useQuery<
    { markdown: string | null; still_validating?: boolean },
    Error
  >({
    queryKey: ['prd-validation-report', prdId],
    queryFn: () =>
      apiFetch(`/api/interviews/prds/${prdId!}/validation/report`),
    enabled: !!prdId && !!validationThreadId && prdStatus === 'validating',
    staleTime: 30_000,
    retry: false,
    refetchInterval: () => {
      if (prdStatus === 'validating') return 10_000;
      return false;
    },
  });
}

export function useCreatePrdValidationThread() {
  const qc = useQueryClient();
  return useMutation<{ threadId: string }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/validation-thread`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

export function useCancelPrdValidation() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/validation/cancel`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prds'] });
      qc.removeQueries({ queryKey: ['prd-validation-report', prdId] });
    },
  });
}

export function useRefreshPrdValidation() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; score: number; is_ready: boolean },
    Error,
    string
  >({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/validation/refresh`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prd-validation-report', prdId] });
    },
  });
}

export function useMarkPrdValidationReady() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/validation/mark-ready`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prds'] });
    },
  });
}

export function useFixPrdValidation() {
  const qc = useQueryClient();
  return useMutation<{ threadId: string }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/fix-validation`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useAcceptFixPrdValidation() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/fix-validation/accept`, {
        method: 'POST',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prds'] });
      qc.removeQueries({ queryKey: ['prd-validation-report', prdId] });
    },
  });
}

export function useRevertPrdSection() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: (prdId) =>
      apiFetch(`/api/interviews/prds/${prdId}/revert-section`, {
        method: 'PATCH',
      }),
    onSuccess: (_data, prdId) => {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useApplyProposedPrd(prdId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/prds/${prdId}/apply-proposed`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      qc.invalidateQueries({ queryKey: ['review-comments', 'prd', prdId] });
      qc.invalidateQueries({
        queryKey: ['unresolved-comment-count', 'prd', prdId],
      });
    },
  });
}

export function useRejectProposedPrd(prdId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/prds/${prdId}/reject-proposed`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useFixPrdWithAi(prdId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/prds/${prdId}/fix-with-ai`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useFixPrdCommentWithAi(prdId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, { commentId: string }>({
    mutationFn: ({ commentId }) =>
      apiFetch(`/api/interviews/prds/${prdId}/fix-comment-with-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['review-comments', 'prd', prdId] });
    },
  });
}

// ── Design Doc AI Fix ─────────────────────────────────────────────────────────

export function useFixDesignDocWithAi(designDocId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/fix-with-ai`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({
        queryKey: ['review-comments', 'design_doc', designDocId],
      });
    },
  });
}

export function useFixDesignDocCommentWithAi(designDocId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, { commentId: string }>({
    mutationFn: ({ commentId }) =>
      apiFetch(
        `/api/interviews/design-docs/${designDocId}/fix-comment-with-ai`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ commentId }),
        }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({
        queryKey: ['review-comments', 'design_doc', designDocId],
      });
    },
  });
}

export function useApplyProposedDesignDoc(designDocId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/apply-proposed`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({
        queryKey: ['review-comments', 'design_doc', designDocId],
      });
      qc.invalidateQueries({
        queryKey: ['unresolved-comment-count', 'design_doc', designDocId],
      });
    },
  });
}

export function useRejectProposedDesignDoc(designDocId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/reject-proposed`, {
        method: 'POST',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
    },
  });
}

// ── PRD → ADO Work Items ─────────────────────────────────────────────────────

export function useCreatePrdAdoItems() {
  const qc = useQueryClient();
  return useMutation<
    CreatePrdAdoItemsResponse,
    Error,
    { prdId: string } & CreatePrdAdoItemsRequest
  >({
    mutationFn: ({ prdId, ...body }) =>
      apiFetch(`/api/interviews/prds/${prdId}/ado-work-items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, { prdId }) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
    },
  });
}

export function useSyncPrdAdoStatus(prdId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ cleared: number }, Error>({
    mutationFn: () =>
      apiFetch(`/api/interviews/prds/${prdId}/sync-ado-status`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      if (data.cleared > 0 && prdId) {
        qc.invalidateQueries({ queryKey: ['prd', prdId] });
      }
    },
  });
}

// ── Owner Approval (two-stage) ───────────────────────────────────────────────

export function useOwnerApproval(prdId: string | null, documentType: OwnerApprovalDocumentType) {
  return useQuery<DocumentOwnerApproval | null>({
    queryKey: ['owner-approval', prdId, documentType],
    queryFn: () =>
      apiFetch(`/api/interviews/prds/${prdId}/owner-approval?documentType=${documentType}`),
    enabled: !!prdId,
    staleTime: 30_000,
  });
}

export function useOwnerApprove(prdId: string | null, documentType: OwnerApprovalDocumentType) {
  const qc = useQueryClient();

  const routeSuffix = documentType === 'prd'
    ? 'owner-approve'
    : documentType === 'test_case'
      ? 'test-cases/owner-approve'
      : 'design-prototypes/owner-approve';

  return useMutation<{ ok: boolean }, Error, OwnerApproveRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/interviews/prds/${prdId}/${routeSuffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['prd', prdId] });
      qc.invalidateQueries({ queryKey: ['owner-approval', prdId, documentType] });
      if (documentType === 'design_prototype') {
        // Invalidate the specific prototype, the PRD's prototype list, and design doc lists.
        if (variables.prototypeId) {
          qc.invalidateQueries({ queryKey: ['design-prototype', variables.prototypeId] });
        }
        qc.invalidateQueries({ queryKey: ['design-prototypes', 'prd', prdId] });
        qc.invalidateQueries({ queryKey: ['design-prototypes'] });
        // Design docs are created async after owner approve — invalidate to pick them up.
        qc.invalidateQueries({ queryKey: ['design-docs', { prdId }] });
        qc.invalidateQueries({ queryKey: ['design-docs'] });
      }
    },
  });
}

// ── Design Doc Owner Approval ─────────────────────────────────────────────────

export function useDesignDocOwnerApproval(designDocId: string | null) {
  return useQuery<DocumentOwnerApproval | null>({
    queryKey: ['design-doc-owner-approval', designDocId],
    queryFn: () =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/owner-approval`),
    enabled: !!designDocId,
    staleTime: 30_000,
  });
}

export function useDesignDocOwnerApprove(designDocId: string | null) {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, Error, OwnerApproveRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/interviews/design-docs/${designDocId}/owner-approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-doc-owner-approval', designDocId] });
      qc.invalidateQueries({ queryKey: ['design-docs'] });
    },
  });
}
