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

export interface SkillToolOption {
  id: string;
  label: string;
  description: string;
}

export interface ProjectSkillTools {
  /** Every tool Apex offers a skill. */
  catalog: SkillToolOption[];
  /** The tool ids this project allows. */
  allowed: string[];
}

export function useProjectSkillTools(project: string) {
  return useQuery({
    queryKey: ['project-skill-tools', project],
    queryFn: () =>
      apiRequest<ProjectSkillTools>(`/api/playbooks/project-skills/tools?${projectQuery(project)}`),
    enabled: Boolean(project),
  });
}

/** Platform admins only. Replaces the project's allowed tools. */
export function useSetProjectSkillTools(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tools: string[]) =>
      apiRequest<ProjectSkillTools>(`/api/playbooks/project-skills/tools?${projectQuery(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['project-skill-tools', project], data);
    },
  });
}

export interface ConnectorWriteOption {
  /** `integration/operation`. */
  id: string;
  integrationLabel: string;
  label: string;
  description: string;
}

export interface ProjectConnectorWrites {
  /** Every connector operation that changes something outside Apex. */
  catalog: ConnectorWriteOption[];
  /** The ids this project allows. */
  allowed: string[];
}

export function useProjectConnectorWrites(project: string) {
  return useQuery({
    queryKey: ['project-connector-writes', project],
    queryFn: () =>
      apiRequest<ProjectConnectorWrites>(`/api/playbooks/connector-writes?${projectQuery(project)}`),
    enabled: Boolean(project),
  });
}

/** Platform admins only. Replaces the project's allowed connector writes. */
export function useSetProjectConnectorWrites(project: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (operations: string[]) =>
      apiRequest<ProjectConnectorWrites>(`/api/playbooks/connector-writes?${projectQuery(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(['project-connector-writes', project], data);
    },
  });
}

export interface SkillDraftModel {
  id: string;
  label: string;
}

export function useSkillDraftModels(project: string) {
  return useQuery({
    queryKey: ['project-skill-draft-models', project],
    queryFn: async () => {
      const data = await apiRequest<{ models: SkillDraftModel[] }>(
        `/api/playbooks/project-skills/draft-models?${projectQuery(project)}`,
      );
      return data.models;
    },
    enabled: Boolean(project),
    staleTime: 60 * 60 * 1000,
  });
}

export function useGenerateProjectSkillDraft(project: string) {
  return useMutation({
    mutationFn: (input: {
      title: string;
      skillType: 'autonomous' | 'interactive';
      request: string;
      modelId?: string;
    }) =>
      apiRequest<{ description: string; instructions: string }>(
        `/api/playbooks/project-skills/draft?${projectQuery(project)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        },
      ),
  });
}

export async function extractSkillFileText(
  project: string,
  input: { fileName: string; base64: string },
): Promise<{ fileName: string; content: string }> {
  return apiRequest(`/api/playbooks/project-skills/extract-text?${projectQuery(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
