import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ProjectSkillConfig,
  UpsertProjectSkillConfigRequest,
  ProjectSkillConfigResponse,
} from '../../shared/types/projectSettings';
import type { AppSetting } from '../../shared/types/appSettings';

export function useProjectSkillConfig(project: string | null | undefined) {
  return useQuery<ProjectSkillConfigResponse | null>({
    queryKey: ['skill-config', project],
    queryFn: async () => {
      if (!project) return null;
      const res = await fetch(`/api/skill-config?project=${encodeURIComponent(project)}`, {
        credentials: 'include',
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('Failed to fetch skill config');
      return res.json() as Promise<ProjectSkillConfigResponse>;
    },
    enabled: !!project,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAllProjectSkillConfigs() {
  return useQuery<ProjectSkillConfig[]>({
    queryKey: ['admin', 'project-settings'],
    queryFn: async () => {
      const res = await fetch('/api/admin/project-settings', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch project settings');
      return res.json() as Promise<ProjectSkillConfig[]>;
    },
    staleTime: 60 * 1000,
  });
}

export function useUpsertProjectSkillConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      project,
      body,
    }: {
      project: string;
      body: UpsertProjectSkillConfigRequest;
    }) => {
      const res = await fetch(`/api/admin/project-settings/${encodeURIComponent(project)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to save project settings');
      return res.json() as Promise<ProjectSkillConfig>;
    },
    onSuccess: (_data, { project }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-settings'] });
      queryClient.invalidateQueries({ queryKey: ['skill-config', project] });
    },
  });
}

export function useDeleteProjectSkillConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (project: string) => {
      const res = await fetch(`/api/admin/project-settings/${encodeURIComponent(project)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to delete project settings');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'project-settings'] });
    },
  });
}

export function useGlobalDefaultModel() {
  return useQuery<AppSetting>({
    queryKey: ['admin', 'app-settings', 'defaultModel'],
    queryFn: async () => {
      const res = await fetch('/api/admin/app-settings/defaultModel', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch global default model');
      return res.json() as Promise<AppSetting>;
    },
    staleTime: 60 * 1000,
  });
}

export function useSetGlobalDefaultModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: string) => {
      const res = await fetch('/api/admin/app-settings/defaultModel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value }),
      });
      if (!res.ok) throw new Error('Failed to save global default model');
      return res.json() as Promise<AppSetting>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'app-settings', 'defaultModel'] });
    },
  });
}

export interface AvailableModel {
  id: string;
  displayName: string;
}

export function useAvailableModels() {
  return useQuery<AvailableModel[]>({
    queryKey: ['admin', 'available-models'],
    queryFn: async () => {
      const res = await fetch('/api/admin/available-models', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch available models');
      const data = (await res.json()) as { models: AvailableModel[] };
      return data.models;
    },
    staleTime: 5 * 60 * 1000,
  });
}
