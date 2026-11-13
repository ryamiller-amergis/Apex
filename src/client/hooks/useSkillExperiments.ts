import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SkillCandidateFrontierEntry,
  SkillExperimentDetail,
  SkillExperimentSkillOption,
  SkillExperimentSummary,
  SkillLearningSettings,
  SkillMinedCheck,
  SkillMinedCheckDecision,
  SkillSemanticChecksView,
  StartSkillExperimentRequest,
} from '../../shared/types/skillExperiment';
import { adminFetch } from './useFoundationSkillAdmin';

const BASE = '/api/platform-admin/skill-health/experiments';
const ACTIVE_POLL_MS = 30_000;

export const skillExperimentKeys = {
  all: (project: string) => ['skill-experiments', project] as const,
  list: (project: string) => ['skill-experiments', project, 'list'] as const,
  detail: (project: string, id: string) => ['skill-experiments', project, 'detail', id] as const,
  settings: (project: string) => ['skill-experiments', project, 'settings'] as const,
  skills: (project: string) => ['skill-experiments', project, 'skills'] as const,
  frontier: (project: string, skillPath: string) => ['skill-experiments', project, 'frontier', skillPath] as const,
  minedChecks: (project: string) => ['skill-experiments', project, 'mined-checks'] as const,
  semanticChecks: (project: string) => ['skill-experiments', project, 'semantic-checks'] as const,
};

function withProject(path: string, project: string): string {
  return `${BASE}${path}?project=${encodeURIComponent(project)}`;
}

function isActive(status: SkillExperimentSummary['status']): boolean {
  return status === 'drafting' || status === 'running' || status === 'awaiting_approval' || status === 'approved';
}

function post<T>(path: string, body: Record<string, unknown>, method = 'POST'): Promise<T> {
  return adminFetch<T>(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function useSkillExperiments(project: string, enabled: boolean) {
  return useQuery<SkillExperimentSummary[]>({
    queryKey: skillExperimentKeys.list(project),
    queryFn: () => adminFetch<SkillExperimentSummary[]>(withProject('', project)),
    enabled,
    refetchInterval: (query) => (query.state.data?.some((e) => isActive(e.status)) ? ACTIVE_POLL_MS : false),
  });
}

export function useSkillExperiment(project: string, id: string | null) {
  return useQuery<SkillExperimentDetail>({
    queryKey: skillExperimentKeys.detail(project, id ?? ''),
    queryFn: () => adminFetch<SkillExperimentDetail>(withProject(`/${encodeURIComponent(id ?? '')}`, project)),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.status) ? ACTIVE_POLL_MS : false),
  });
}

export function useSkillLearningSettings(project: string, enabled: boolean) {
  return useQuery<SkillLearningSettings>({
    queryKey: skillExperimentKeys.settings(project),
    queryFn: () => adminFetch<SkillLearningSettings>(withProject('/settings', project)),
    enabled,
  });
}

export function useReplayableSkills(project: string, enabled: boolean) {
  return useQuery<SkillExperimentSkillOption[]>({
    queryKey: skillExperimentKeys.skills(project),
    queryFn: () => adminFetch<SkillExperimentSkillOption[]>(withProject('/skills', project)),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCandidateFrontier(project: string, skillPath: string) {
  return useQuery<SkillCandidateFrontierEntry[]>({
    queryKey: skillExperimentKeys.frontier(project, skillPath),
    queryFn: () => adminFetch<SkillCandidateFrontierEntry[]>(
      `${withProject('/frontier', project)}&skillPath=${encodeURIComponent(skillPath)}`,
    ),
    enabled: skillPath.length > 0,
  });
}

export function useMinedChecks(project: string, enabled: boolean) {
  return useQuery<SkillMinedCheck[]>({
    queryKey: skillExperimentKeys.minedChecks(project),
    queryFn: () => adminFetch<SkillMinedCheck[]>(withProject('/mined-checks', project)),
    enabled,
  });
}

export function useDecideMinedCheck(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillMinedCheck[], Error, Pick<SkillMinedCheck, 'stageKey' | 'heading' | 'support'> & { decision: SkillMinedCheckDecision }>({
    mutationFn: (input) => post<SkillMinedCheck[]>('/mined-checks', { project, ...input }, 'PUT'),
    onSuccess: (checks) => queryClient.setQueryData(skillExperimentKeys.minedChecks(project), checks),
  });
}

export function useSemanticChecks(project: string, enabled: boolean) {
  return useQuery<SkillSemanticChecksView>({
    queryKey: skillExperimentKeys.semanticChecks(project),
    queryFn: () => adminFetch<SkillSemanticChecksView>(withProject('/semantic-checks', project)),
    enabled,
    refetchInterval: (query) => (query.state.data?.latestRuns.some((r) => r.status === 'running') ? ACTIVE_POLL_MS : false),
  });
}

export function useSuggestSemanticChecks(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillSemanticChecksView, Error, string>({
    mutationFn: (stageKey) => post<SkillSemanticChecksView>('/semantic-checks/suggest', { project, stageKey }),
    onSuccess: (view) => {
      queryClient.setQueryData(skillExperimentKeys.semanticChecks(project), view);
      void queryClient.invalidateQueries({ queryKey: skillExperimentKeys.settings(project) });
    },
  });
}

export function useDecideSemanticCheck(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillSemanticChecksView, Error, { id: string; decision: SkillMinedCheckDecision }>({
    mutationFn: ({ id, decision }) => post<SkillSemanticChecksView>(`/semantic-checks/${encodeURIComponent(id)}`, { project, decision }, 'PUT'),
    onSuccess: (view) => queryClient.setQueryData(skillExperimentKeys.semanticChecks(project), view),
  });
}

export function useSetSkillLearningBudget(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillLearningSettings, Error, number | null>({
    mutationFn: (monthlyBudgetUsd) => post<SkillLearningSettings>('/settings', { project, monthlyBudgetUsd }, 'PUT'),
    onSuccess: (settings) => queryClient.setQueryData(skillExperimentKeys.settings(project), settings),
  });
}

export function useStartSkillExperiment(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillExperimentSummary, Error, StartSkillExperimentRequest>({
    mutationFn: (request) => post<SkillExperimentSummary>('', { project, ...request }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillExperimentKeys.all(project) }),
  });
}

export function useSkillExperimentAction(project: string) {
  const queryClient = useQueryClient();
  return useMutation<SkillExperimentSummary, Error, { id: string; action: 'cancel' | 'retry-promotion' }>({
    mutationFn: ({ id, action }) => post<SkillExperimentSummary>(`/${encodeURIComponent(id)}/${action}`, { project }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: skillExperimentKeys.all(project) }),
  });
}
