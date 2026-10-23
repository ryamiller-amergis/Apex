import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CloudBackgroundJob,
  SaveCloudBackgroundJobRequest,
  StartCloudBackgroundJobResponse,
} from '../../shared/types/cloudBackgroundJob';
import type { CloudBackgroundJobDraft } from '../../shared/utils/cloudBackgroundJob';

const LIVE_RUN = new Set(['queued', 'dispatched', 'running']);

async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed: ${response.status}`);
  }
  return body as T;
}

export function useCloudBackgroundJobs(project: string) {
  return useQuery<CloudBackgroundJob[]>({
    queryKey: ['cloud-background-jobs', project],
    queryFn: async () => {
      const response = await fetch(
        `/api/admin/cloud-background-jobs?project=${encodeURIComponent(project)}`,
        { credentials: 'include' },
      );
      return readBody<CloudBackgroundJob[]>(response);
    },
    enabled: Boolean(project),
    refetchInterval: (query) => {
      const jobs = query.state.data ?? [];
      const live = jobs.some((job) => job.runs.some((run) => LIVE_RUN.has(run.status)));
      return live ? 10_000 : false;
    },
  });
}

export function useSaveCloudBackgroundJob(project: string) {
  const queryClient = useQueryClient();
  return useMutation<CloudBackgroundJob, Error, { id?: string; draft: CloudBackgroundJobDraft }>({
    mutationFn: async ({ id, draft }) => {
      const body: SaveCloudBackgroundJobRequest = { project, ...draft };
      const response = await fetch(
        id ? `/api/admin/cloud-background-jobs/${id}` : '/api/admin/cloud-background-jobs',
        {
          method: id ? 'PUT' : 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return readBody<CloudBackgroundJob>(response);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-background-jobs', project] });
    },
  });
}

export function useDeleteCloudBackgroundJob(project: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const response = await fetch(
        `/api/admin/cloud-background-jobs/${id}?project=${encodeURIComponent(project)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      await readBody<void>(response);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-background-jobs', project] });
    },
  });
}

export function useRunCloudBackgroundJob(project: string) {
  const queryClient = useQueryClient();
  return useMutation<StartCloudBackgroundJobResponse, Error, string>({
    mutationFn: async (id) => {
      const response = await fetch(`/api/admin/cloud-background-jobs/${id}/run`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      });
      return readBody<StartCloudBackgroundJobResponse>(response);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-background-jobs', project] });
    },
  });
}
