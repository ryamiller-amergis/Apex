import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BuildBriefAnalysisMissing,
  BuildBriefAnalysisResponse,
  BuildClassificationResult,
  SaveBuildBriefRequest,
} from '../../shared/types/build';
import type { InterviewBriefRecord } from '../../shared/types/interview';
import { ApiFetchError, apexProjectHeaders, apiFetch } from '../utils/apiFetch';

/** How often the panel checks for a draft while none exists. */
export const BUILD_BRIEF_POLL_MS = 5_000;

export type BuildBriefAnalysisState =
  | { kind: 'ready'; analysis: BuildBriefAnalysisResponse }
  | { kind: 'missing'; draftFailed: boolean };

export interface ApproveBuildBriefResponse {
  version: number;
  resumed: boolean;
  alreadyApproved: boolean;
  classification?: BuildClassificationResult;
}

export const buildBriefKey = (interviewId: string) => ['interview-brief', interviewId] as const;
export const buildBriefAnalysisKey = (interviewId: string) => ['build-brief-analysis', interviewId] as const;

async function fetchAnalysis(interviewId: string): Promise<BuildBriefAnalysisState> {
  const res = await fetch(`/api/interviews/${interviewId}/brief/analysis`, {
    credentials: 'include',
    headers: apexProjectHeaders(),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) {
    return { kind: 'missing', draftFailed: Boolean((body as Partial<BuildBriefAnalysisMissing>).draftFailed) };
  }
  if (!res.ok) {
    throw new ApiFetchError((body as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return { kind: 'ready', analysis: body as BuildBriefAnalysisResponse };
}

function retryUnlessRefused(failureCount: number, error: Error): boolean {
  if (error instanceof ApiFetchError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function useBuildBriefRecord(interviewId: string) {
  return useQuery<InterviewBriefRecord | null>({
    queryKey: buildBriefKey(interviewId),
    queryFn: () => apiFetch(`/api/interviews/${interviewId}/brief`),
    refetchInterval: (query) => (query.state.data ? false : BUILD_BRIEF_POLL_MS),
    retry: retryUnlessRefused,
  });
}

export function useBuildBriefAnalysis(interviewId: string) {
  return useQuery<BuildBriefAnalysisState>({
    queryKey: buildBriefAnalysisKey(interviewId),
    queryFn: () => fetchAnalysis(interviewId),
    refetchInterval: (query) => (query.state.data?.kind === 'missing' ? BUILD_BRIEF_POLL_MS : false),
    retry: retryUnlessRefused,
  });
}

function useInvalidateBuildBrief() {
  const qc = useQueryClient();
  return (interviewId: string) => {
    void qc.invalidateQueries({ queryKey: buildBriefKey(interviewId) });
    void qc.invalidateQueries({ queryKey: buildBriefAnalysisKey(interviewId) });
    void qc.invalidateQueries({ queryKey: ['interview', interviewId] });
  };
}

export function useSaveBuildBrief(interviewId: string) {
  const invalidate = useInvalidateBuildBrief();
  return useMutation<InterviewBriefRecord, Error, SaveBuildBriefRequest>({
    mutationFn: (body) =>
      apiFetch(`/api/interviews/${interviewId}/brief`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSettled: () => invalidate(interviewId),
  });
}

export function useDraftBuildBrief(interviewId: string) {
  const invalidate = useInvalidateBuildBrief();
  return useMutation<InterviewBriefRecord, Error, void>({
    mutationFn: () => apiFetch(`/api/interviews/${interviewId}/brief/draft`, { method: 'POST' }),
    onSettled: () => invalidate(interviewId),
  });
}

export function useApproveBuildBrief(interviewId: string) {
  const invalidate = useInvalidateBuildBrief();
  return useMutation<ApproveBuildBriefResponse, Error, void>({
    mutationFn: () => apiFetch(`/api/interviews/${interviewId}/brief/approve`, { method: 'POST' }),
    onSettled: () => invalidate(interviewId),
  });
}
