import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../utils/apiFetch';

export interface ProductSetupCandidate {
  userId: string;
  displayName: string;
  email: string;
}

export interface ProductSetupStatus {
  active: boolean;
  skillPath: string;
  model: string;
  candidates: ProductSetupCandidate[];
  foundationAnswers: string[];
}

const INACTIVE: ProductSetupStatus = {
  active: false,
  skillPath: '.agents/skills/product-foundation/SKILL.md',
  model: 'auto',
  candidates: [],
  foundationAnswers: [],
};

export function draftProductFoundation(project: string, answers: string[]): Promise<{ markdown: string }> {
  return apiFetch('/api/admin/product-setup/draft', {
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
  return apiFetch('/api/admin/product-setup/revise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, draft, changes }),
  });
}

export function saveProductFoundation(project: string, markdown: string): Promise<{ ok: boolean }> {
  return apiFetch('/api/admin/product-setup/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project, markdown }),
  });
}

export function useProductSetup(project: string | null | undefined) {
  return useQuery<ProductSetupStatus>({
    queryKey: ['product-setup', project],
    enabled: Boolean(project),
    queryFn: async () => {
      try {
        return await apiFetch<ProductSetupStatus>(
          `/api/admin/product-setup?project=${encodeURIComponent(project!)}`,
        );
      } catch {
        return INACTIVE;
      }
    },
    refetchInterval: (query) => (query.state.data?.active ? 30_000 : false),
  });
}
