import { useQuery } from '@tanstack/react-query';
import type {
  GroundingGateEvaluation,
  GroundingRolloutStage,
} from '../../shared/types/groundingOperations';

async function loadGroundingRolloutStatus(
  stage: GroundingRolloutStage,
  project?: string,
): Promise<GroundingGateEvaluation> {
  const params = new URLSearchParams({ stage });
  if (project) params.set('project', project);

  const response = await fetch(
    `/api/platform-admin/grounding/rollout-status?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<GroundingGateEvaluation>;
}

export function useGroundingRolloutStatus(
  stage: GroundingRolloutStage,
  project?: string,
) {
  return useQuery<GroundingGateEvaluation>({
    queryKey: ['platform-admin', 'grounding-rollout-status', stage, project ?? null],
    queryFn: () => loadGroundingRolloutStatus(stage, project),
    staleTime: 30_000,
    retry: 1,
  });
}
