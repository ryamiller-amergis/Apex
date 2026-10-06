import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatThreadSummary } from '../../shared/types/chat';
import type { ProductBuild, ProductBuildSummary } from '../../shared/types/productBuild';
import type { UiLabDesign } from '../../shared/types/uiLab';
import { apiFetch } from '../utils/apiFetch';

export interface ProductSetupCandidate {
  userId: string;
  displayName: string;
  email: string;
}

export interface ProductSetupFoundationStatus {
  active: boolean;
  phase: 'foundation';
  skillPath: string;
  model: string;
  candidates: ProductSetupCandidate[];
  canInviteTeammates: boolean;
  foundationAnswers: string[];
  build: null;
  chatThreadId: null;
  thread: null;
  design: null;
}

export interface ProductBuildSetupStatus {
  active: true;
  phase: 'build';
  skillPath: string;
  model: string;
  candidates: ProductSetupCandidate[];
  foundationAnswers: string[];
  project: string;
  build: ProductBuild;
  chatThreadId: string | null;
  thread: ChatThreadSummary | null;
  design: UiLabDesign | null;
  history: ProductBuildSummary[];
}

export type ProductSetupStatus = ProductSetupFoundationStatus | ProductBuildSetupStatus;

const INACTIVE: ProductSetupFoundationStatus = {
  active: false,
  phase: 'foundation',
  skillPath: '.agents/skills/product-foundation/SKILL.md',
  model: 'auto',
  candidates: [],
  canInviteTeammates: false,
  foundationAnswers: [],
  build: null,
  chatThreadId: null,
  thread: null,
  design: null,
};

const ACTIVE_POLL_MS = 30_000;
const BUILD_POLL_MS = 5_000;

/** How often Home should reload setup so discovery, prototype, and build changes show up. */
export function productSetupRefetchInterval(status: ProductSetupStatus | undefined): number | false {
  if (!status?.active) return false;
  if (status.phase !== 'build') return ACTIVE_POLL_MS;
  if (status.build.status === 'discovery' || status.build.status === 'building' || status.build.status === 'pr-open') {
    return status.build.status === 'pr-open' ? ACTIVE_POLL_MS : BUILD_POLL_MS;
  }
  if (status.build.status === 'prototype') {
    const design = status.design;
    if (!design || design.status === 'generating' || design.status === 'streaming') return BUILD_POLL_MS;
  }
  return false;
}

export function draftProductFoundation(project: string, answers: string[]): Promise<{ markdown: string }> {
  return apiFetch('/api/product-builds/foundation/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, answers }),
  });
}

export function reviseProductFoundation(
  project: string,
  draft: string,
  changes: string,
): Promise<{ markdown: string }> {
  return apiFetch('/api/product-builds/foundation/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, draft, changes }),
  });
}

export function saveProductFoundation(project: string, markdown: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/product-builds/foundation/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, markdown }),
  });
}

export function syncProductBuild(buildId: string): Promise<ProductSetupStatus> {
  return apiFetch(`/api/product-builds/${encodeURIComponent(buildId)}/sync`, { method: 'POST' });
}

export function regenerateProductPrototype(buildId: string, feedback: string): Promise<ProductSetupStatus> {
  return apiFetch(`/api/product-builds/${encodeURIComponent(buildId)}/prototype/regenerate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feedback }),
  });
}

export function approveProductBuild(buildId: string): Promise<ProductSetupStatus> {
  return apiFetch(`/api/product-builds/${encodeURIComponent(buildId)}/approve`, { method: 'POST' });
}

export function startNextProductBuild(project: string, prompt: string): Promise<ProductSetupStatus> {
  return apiFetch('/api/product-builds/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, prompt }),
  });
}

export function useProductSetup(project: string | null | undefined) {
  return useQuery<ProductSetupStatus>({
    queryKey: ['product-setup', project],
    enabled: Boolean(project),
    queryFn: async () => {
      try {
        return await apiFetch<ProductSetupStatus>(
          `/api/product-builds/setup?project=${encodeURIComponent(project!)}`,
        );
      } catch {
        return INACTIVE;
      }
    },
    refetchInterval: (query) => productSetupRefetchInterval(query.state.data),
  });
}

function useRefreshProductSetup(project: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['product-setup', project] });
}

export function useSyncProductBuild(project: string) {
  const refresh = useRefreshProductSetup(project);
  return useMutation({
    mutationFn: (buildId: string) => syncProductBuild(buildId),
    onSettled: () => refresh(),
  });
}

export function useRegenerateProductPrototype(project: string) {
  const refresh = useRefreshProductSetup(project);
  return useMutation({
    mutationFn: ({ buildId, feedback }: { buildId: string; feedback: string }) =>
      regenerateProductPrototype(buildId, feedback),
    onSettled: () => refresh(),
  });
}

export function useApproveProductBuild(project: string) {
  const refresh = useRefreshProductSetup(project);
  return useMutation({
    mutationFn: (buildId: string) => approveProductBuild(buildId),
    onSettled: () => refresh(),
  });
}

export function useStartNextProductBuild(project: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshProductSetup(project);
  return useMutation({
    mutationFn: (prompt: string) => startNextProductBuild(project, prompt),
    onSuccess: (status) => {
      queryClient.setQueryData(['product-setup', project], status);
    },
    onSettled: () => refresh(),
  });
}
