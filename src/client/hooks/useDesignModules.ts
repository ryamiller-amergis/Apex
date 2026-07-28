import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDesignModuleInput,
  CreateDesignModuleResult,
  DesignModule,
  DesignModuleSummary,
  RegenerateDesignModuleInput,
  RegenerateDesignModuleResult,
  UpdateDesignModuleInput,
} from '../../shared/types/designModule';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed: ${response.status}`
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const designModuleKey = (project: string, slug?: string) =>
  slug
    ? (['design-modules', project, slug] as const)
    : (['design-modules', project] as const);

export function useDesignModules(project: string) {
  return useQuery<DesignModuleSummary[]>({
    queryKey: designModuleKey(project),
    queryFn: () =>
      apiFetch(`/api/design-modules?project=${encodeURIComponent(project)}`),
    staleTime: 30_000,
    enabled: Boolean(project),
  });
}

export function useDesignModule(project: string, slug: string | null) {
  return useQuery<DesignModule>({
    queryKey: designModuleKey(project, slug ?? undefined),
    queryFn: () =>
      apiFetch(
        `/api/design-modules/${encodeURIComponent(slug ?? '')}?project=${encodeURIComponent(project)}`
      ),
    enabled: Boolean(slug) && Boolean(project),
    refetchInterval: 10_000,
  });
}

export function useCreateDesignModule(project: string) {
  const queryClient = useQueryClient();
  return useMutation<CreateDesignModuleResult, Error, CreateDesignModuleInput>({
    mutationFn: (body) =>
      apiFetch('/api/design-modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (module) => {
      const { generation: _generation, ...stored } = module;
      queryClient.setQueryData(designModuleKey(project, module.slug), stored);
      queryClient.setQueryData<DesignModuleSummary[]>(
        designModuleKey(project),
        (existing) => {
          const summary: DesignModuleSummary = {
            id: stored.id,
            project: stored.project,
            slug: stored.slug,
            label: stored.label,
            description: stored.description,
            iconKey: stored.iconKey,
            sourceGlobs: stored.sourceGlobs,
            sortOrder: stored.sortOrder,
            hasContent: stored.hasContent,
            isStale: stored.isStale,
            sourceAvailable: stored.sourceAvailable,
            lastGeneratedAt: stored.lastGeneratedAt,
            generatedByModel: stored.generatedByModel,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
          };
          const next = !existing
            ? [summary]
            : existing.some((item) => item.slug === summary.slug)
              ? existing.map((item) =>
                  item.slug === summary.slug ? summary : item
                )
              : [...existing, summary];
          return [...next].sort((a, b) =>
            a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
          );
        }
      );
      queryClient.invalidateQueries({ queryKey: designModuleKey(project) });
    },
  });
}

export function useUpdateDesignModule(project: string) {
  const queryClient = useQueryClient();
  return useMutation<
    DesignModule,
    Error,
    { slug: string; input: UpdateDesignModuleInput }
  >({
    mutationFn: ({ slug, input }) =>
      apiFetch(
        `/api/design-modules/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      ),
    onSuccess: (module, variables) => {
      queryClient.removeQueries({
        queryKey: designModuleKey(project, variables.slug),
      });
      queryClient.setQueryData(designModuleKey(project, module.slug), module);
      queryClient.invalidateQueries({ queryKey: designModuleKey(project) });
    },
  });
}

export function useDeleteDesignModule(project: string) {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (slug) =>
      apiFetch(
        `/api/design-modules/${encodeURIComponent(slug)}?project=${encodeURIComponent(project)}`,
        { method: 'DELETE' }
      ),
    onSuccess: (_result, slug) => {
      queryClient.removeQueries({
        queryKey: designModuleKey(project, slug),
      });
      queryClient.invalidateQueries({ queryKey: designModuleKey(project) });
    },
  });
}

export function useRegenerateDesignModule(project: string) {
  const queryClient = useQueryClient();
  return useMutation<
    RegenerateDesignModuleResult,
    Error,
    { slug: string; input: RegenerateDesignModuleInput }
  >({
    mutationFn: ({ slug, input }) =>
      apiFetch(`/api/design-modules/${encodeURIComponent(slug)}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({
        queryKey: designModuleKey(project, variables.slug),
      });
      queryClient.invalidateQueries({ queryKey: designModuleKey(project) });
    },
  });
}
