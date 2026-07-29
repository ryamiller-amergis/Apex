import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GenerateWalkthroughAiDraftRequest,
  GenerateWalkthroughAiDraftResponse,
  RedoWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitSuccess,
  WalkthroughAiPolicyPreset,
  WalkthroughAiProposalUnit,
} from '../../shared/types/walkthroughAiDraft';

async function aiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body as { error?: string }).error ?? `HTTP ${res.status}`) as Error & {
      code?: string;
      status?: number;
    };
    err.code = (body as { code?: string }).code;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export function useWalkthroughAiPolicyPresets() {
  return useQuery<{ defaultPreset: 'A' | 'B' | 'C'; presets: WalkthroughAiPolicyPreset[] }>({
    queryKey: ['platform-admin', 'walkthroughs', 'ai-policy-presets'],
    queryFn: () =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/policy-presets'),
    staleTime: 300_000,
  });
}

export function useGenerateWalkthroughAiDraft() {
  return useMutation<GenerateWalkthroughAiDraftResponse, Error, GenerateWalkthroughAiDraftRequest>({
    mutationFn: (body) =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}

export function useRedoWalkthroughAiUnit() {
  return useMutation<{ unit: WalkthroughAiProposalUnit }, Error, RedoWalkthroughAiUnitRequest>({
    mutationFn: (body) =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/redo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}

export function useValidateWalkthroughAiUnit() {
  return useMutation<ValidateWalkthroughAiUnitSuccess, Error, ValidateWalkthroughAiUnitRequest>({
    mutationFn: (body) =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/validate-unit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}
