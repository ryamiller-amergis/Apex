import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GenerateWalkthroughAiDraftRequest,
  GenerateWalkthroughAiDraftResponse,
  GenerateWalkthroughAiStepRequest,
  GenerateWalkthroughAiStepResponse,
  RedoWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitRequest,
  ValidateWalkthroughAiUnitSuccess,
  WalkthroughAiPolicyPreset,
  WalkthroughAiProposal,
  WalkthroughAiProposalUnit,
} from '../../shared/types/walkthroughAiDraft';
import { resolveWalkthroughAiPolicyPreset } from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughGenerationProvenance } from '../../shared/types/walkthrough';
import type { WalkthroughAnchorDiscoveryProposal } from '../../shared/types/walkthroughAnchorDiscovery';

/** Client-facing ranked candidate shape (mirrors server RankedWalkthroughAnchorCandidate). */
export interface WalkthroughAnchorMatchCandidate {
  anchorKey: string;
  testId: string;
  label: string;
  approvedRoute: string | null;
  allowedPlacements: readonly string[];
  smartTags: readonly string[];
  score: number;
  evidence: {
    routeCompatible: boolean;
    matchedTags: string[];
  };
}

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

/**
 * Generate exactly one new Step for an existing Walkthrough (direct-provider,
 * synchronous — no thread polling). Returns a reviewable step unit.
 */
export function useGenerateWalkthroughAiStep() {
  return useMutation<GenerateWalkthroughAiStepResponse, Error, GenerateWalkthroughAiStepRequest>({
    mutationFn: (body) =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/generate-step', {
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

export interface WalkthroughAnchorMatchesQuery {
  intent?: string | null;
  heading?: string | null;
  body?: string | null;
  route?: string | null;
}

export interface WalkthroughAnchorMatchesResponse {
  rankedCandidates: WalkthroughAnchorMatchCandidate[];
  autoSelectThreshold: number;
}

export function useWalkthroughAnchorMatches() {
  return useMutation<
    WalkthroughAnchorMatchesResponse,
    Error,
    WalkthroughAnchorMatchesQuery
  >({
    mutationFn: (body) =>
      aiFetch('/api/platform-admin/walkthroughs/ai-drafts/anchor-matches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
  });
}

export interface StartAnchorDiscoveryRequest {
  heading: string;
  body?: string | null;
  route?: string | null;
  intent?: string | null;
  model?: string;
  skillPath?: string;
}

export interface StartAnchorDiscoveryResponse {
  proposals: WalkthroughAnchorDiscoveryProposal[];
  provenance?: {
    provider: 'cursor';
    model: string;
    skillPath: string;
    generatedAt: string;
    threadId: string;
  };
}

export function useStartAnchorDiscovery() {
  return useMutation<StartAnchorDiscoveryResponse, Error, StartAnchorDiscoveryRequest>({
    mutationFn: async (body) => {
      const started = await aiFetch<{
        threadId: string;
        provenance: StartAnchorDiscoveryResponse['provenance'];
      }>('/api/platform-admin/walkthroughs/ai-drafts/anchor-discovery/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const result = await aiFetch<{
          status: 'pending' | 'ready' | 'failed' | 'cancelled';
          result?: { proposals: WalkthroughAnchorDiscoveryProposal[] };
          error?: string;
        }>(
          `/api/platform-admin/walkthroughs/ai-drafts/anchor-discovery/status/${encodeURIComponent(started.threadId)}`,
        );
        if (result.status === 'ready' && result.result) {
          return {
            proposals: result.result.proposals,
            provenance: started.provenance,
          };
        }
        if (result.status === 'failed' || result.status === 'cancelled') {
          throw new Error(result.error || `Anchor discovery ${result.status}.`);
        }
      }

      await aiFetch('/api/platform-admin/walkthroughs/ai-drafts/anchor-discovery/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: started.threadId }),
      }).catch(() => undefined);
      throw new Error('Anchor discovery timed out. Try again.');
    },
  });
}
