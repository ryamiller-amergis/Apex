import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GenerateWalkthroughAiDraftRequest,
  GenerateWalkthroughAiDraftResponse,
  RedoWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitSuccess,
  WalkthroughAiPolicyPreset,
  WalkthroughAiProposal,
  WalkthroughAiProposalUnit,
} from '../../shared/types/walkthroughAiDraft';
import { resolveWalkthroughAiPolicyPreset } from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughGenerationProvenance } from '../../shared/types/walkthrough';

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
    mutationFn: async (body) => {
      const started = await aiFetch<{
        threadId: string;
        provenance: WalkthroughGenerationProvenance;
      }>('/api/platform-admin/walkthroughs/ai-drafts/generate/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const policy = resolveWalkthroughAiPolicyPreset(body.policyPreset);
      const deadline = Date.now() + policy.timeoutMs + 30_000;

      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const result = await aiFetch<{
          status: 'pending' | 'ready' | 'failed' | 'cancelled';
          proposal?: WalkthroughAiProposal;
          error?: string;
        }>(
          `/api/platform-admin/walkthroughs/ai-drafts/generate/status/${encodeURIComponent(started.threadId)}`,
        );
        if (result.status === 'ready' && result.proposal) {
          return { proposal: result.proposal };
        }
        if (result.status === 'failed' || result.status === 'cancelled') {
          throw new Error(result.error || `Walkthrough generation ${result.status}.`);
        }
      }

      await aiFetch('/api/platform-admin/walkthroughs/ai-drafts/generate/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: started.threadId }),
      }).catch(() => undefined);
      throw new Error('Walkthrough generation timed out. Try again.');
    },
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
