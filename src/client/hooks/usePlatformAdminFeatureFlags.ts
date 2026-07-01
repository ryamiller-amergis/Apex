import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddRuleRequest,
  CreateFlagRequest,
  FeatureFlag,
  FeatureFlagRule,
  FeatureFlagWithRules,
  FlagAuditEntry,
  UpdateFlagRequest,
} from '../../shared/types/featureFlags';

const FEATURE_FLAGS_KEY = ['platform-admin', 'feature-flags'] as const;

async function flagsFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export function useFeatureFlagsList() {
  return useQuery<FeatureFlagWithRules[]>({
    queryKey: [...FEATURE_FLAGS_KEY],
    queryFn: () => flagsFetch<FeatureFlagWithRules[]>('/api/platform-admin/feature-flags'),
    staleTime: 30_000,
  });
}

export function useCreateFeatureFlag() {
  const queryClient = useQueryClient();
  return useMutation<FeatureFlag, Error, CreateFlagRequest>({
    mutationFn: (body) =>
      flagsFetch<FeatureFlag>('/api/platform-admin/feature-flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...FEATURE_FLAGS_KEY] });
    },
  });
}

export function useUpdateFeatureFlag() {
  const queryClient = useQueryClient();
  return useMutation<FeatureFlag, Error, { id: string } & UpdateFlagRequest>({
    mutationFn: ({ id, ...body }) =>
      flagsFetch<FeatureFlag>(`/api/platform-admin/feature-flags/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...FEATURE_FLAGS_KEY] });
    },
  });
}

export function useDeleteFeatureFlag() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { id: string }>({
    mutationFn: ({ id }) =>
      flagsFetch<void>(`/api/platform-admin/feature-flags/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...FEATURE_FLAGS_KEY] });
    },
  });
}

export function useAddFlagRule() {
  const queryClient = useQueryClient();
  return useMutation<FeatureFlagRule, Error, { flagId: string } & AddRuleRequest>({
    mutationFn: ({ flagId, ...body }) =>
      flagsFetch<FeatureFlagRule>(`/api/platform-admin/feature-flags/${encodeURIComponent(flagId)}/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...FEATURE_FLAGS_KEY] });
    },
  });
}

export function useRemoveFlagRule() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { flagId: string; ruleId: string }>({
    mutationFn: ({ flagId, ruleId }) =>
      flagsFetch<void>(
        `/api/platform-admin/feature-flags/${encodeURIComponent(flagId)}/rules/${encodeURIComponent(ruleId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...FEATURE_FLAGS_KEY] });
    },
  });
}

export function useFlagAudit(flagId: string | null) {
  return useQuery<FlagAuditEntry[]>({
    queryKey: ['platform-admin', 'feature-flags', flagId, 'audit'],
    queryFn: () =>
      flagsFetch<FlagAuditEntry[]>(`/api/platform-admin/feature-flags/${encodeURIComponent(flagId!)}/audit`),
    enabled: !!flagId,
    staleTime: 30_000,
  });
}
