import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateDesignModuleInput,
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

const designModuleKey = (slug?: string) =>
  slug ? (['design-modules', slug] as const) : (['design-modules'] as const);

export function useDesignModules() {
  return useQuery<DesignModuleSummary[]>({
    queryKey: designModuleKey(),
    queryFn: () => apiFetch('/api/design-modules'),
    staleTime: 30_000,
  });
}

export function useDesignModule(slug: string | null) {
  return useQuery<DesignModule>({
    queryKey: designModuleKey(slug ?? undefined),
    queryFn: () =>
      apiFetch(`/api/design-modules/${encodeURIComponent(slug ?? '')}`),
    enabled: Boolean(slug),
    refetchInterval: 10_000,
  });
}

export function useCreateDesignModule() {
  const queryClient = useQueryClient();
  return useMutation<DesignModule, Error, CreateDesignModuleInput>({
    mutationFn: (body) =>
      apiFetch('/api/design-modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: (module) => {
      queryClient.setQueryData(designModuleKey(module.slug), module);
      queryClient.invalidateQueries({ queryKey: designModuleKey() });
    },
  });
}

export function useUpdateDesignModule() {
  const queryClient = useQueryClient();
  return useMutation<
    DesignModule,
    Error,
    { slug: string; input: UpdateDesignModuleInput }
  >({
    mutationFn: ({ slug, input }) =>
      apiFetch(`/api/design-modules/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
    onSuccess: (module, variables) => {
      queryClient.removeQueries({ queryKey: designModuleKey(variables.slug) });
      queryClient.setQueryData(designModuleKey(module.slug), module);
      queryClient.invalidateQueries({ queryKey: designModuleKey() });
    },
  });
}

export function useDeleteDesignModule() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (slug) =>
      apiFetch(`/api/design-modules/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_result, slug) => {
      queryClient.removeQueries({ queryKey: designModuleKey(slug) });
      queryClient.invalidateQueries({ queryKey: designModuleKey() });
    },
  });
}

export function useRegenerateDesignModule() {
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
        queryKey: designModuleKey(variables.slug),
      });
      queryClient.invalidateQueries({ queryKey: designModuleKey() });
    },
  });
}
