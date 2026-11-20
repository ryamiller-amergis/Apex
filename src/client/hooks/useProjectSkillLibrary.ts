import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectSkillLibraryItem } from '../utils/projectSkillLibrary';

class SkillLibraryApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLibraryApiError';
  }
}

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = (body as { error?: string }).error;
    throw new SkillLibraryApiError(error ?? `Request failed: ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function projectQuery(project: string): string {
  return `project=${encodeURIComponent(project)}`;
}

export function useProjectSkillLibrary(project: string) {
  return useQuery({
    queryKey: ['project-skill-library', project],
    queryFn: () =>
      apiRequest<{ skills: ProjectSkillLibraryItem[] }>(
        `/api/playbooks/project-skills?${projectQuery(project)}`,
      ),
    enabled: Boolean(project),
  });
}

export function useSaveProjectSkill(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      content: string;
      companions?: { path: string; content: string; classification: 'instruction' | 'reference' }[];
    }) =>
      apiRequest(`/api/playbooks/skills?${projectQuery(project)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['project-skill-library', project] });
    },
  });
}
