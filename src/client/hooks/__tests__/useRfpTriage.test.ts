import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RfpGeneratedDraft } from '../../../shared/types/rfpIntake';
import {
  usePublishRfpProposal,
  useRegenerateRfpProposal,
  useRfpQueue,
  useRfpStatusTransition,
  useRfpTriageDetail,
  useSaveRfpProposalDraft,
  useSubmitRfpReview,
} from '../useRfpTriage';

describe('proposal workflow mutations', () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'rfp-1' }),
    }) as jest.Mock;
  });

  it('SR-0 posts the review with the architecture and sizing', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSubmitRfpReview(), { wrapper });
    const architecture = {
      appType: 'console' as const,
      resources: ['rds' as const],
      requiresAi: false,
      domainName: null,
      sizing: {
        region: 'us-east' as const,
        sizingProfile: 'small' as const,
        environmentCount: 2,
        uptimePattern: 'business-hours' as const,
        storageGb: 20,
        aiUsage: null,
      },
    };

    await act(async () => {
      await result.current.mutateAsync({ id: 'rfp-1', architecture });
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests/rfp-1/submit-review',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ architecture }) }),
    );
  });

  it('RG-0 posts a regenerate request', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRegenerateRfpProposal(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'rfp-1' });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests/rfp-1/proposal/regenerate',
      expect.objectContaining({ method: 'POST', body: undefined }),
    );
  });

  it('DR-0 puts the edited draft', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useSaveRfpProposalDraft(), { wrapper });
    const draft = { kind: 'decision-summary', jobId: 'job-1' } as unknown as RfpGeneratedDraft;
    await act(async () => {
      await result.current.mutateAsync({ id: 'rfp-1', draft });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests/rfp-1/proposal-draft',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ draft }) }),
    );
  });

  it('PB-0 publishes with the product owner', async () => {
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePublishRfpProposal(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: 'rfp-1', productOwnerId: 'po-1' });
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests/rfp-1/proposal-draft/publish',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ productOwnerId: 'po-1' }) }),
    );
  });
});

describe('useRfpTriageDetail polling', () => {
  afterEach(() => jest.useRealTimers());

  function detailWith(status: string | null) {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        id: 'rfp-1',
        proposalGeneration: status ? { jobId: 'job-1', status } : null,
      }),
    };
  }

  it('PG-3 polls while generation is active and stops once it is ready', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(detailWith('researching-prices'))
      .mockResolvedValue(detailWith('ready')) as jest.Mock;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRfpTriageDetail('rfp-1', true), { wrapper });

    await waitFor(() => expect(result.current.data?.proposalGeneration?.status).toBe('researching-prices'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(4_000);
    });
    await waitFor(() => expect(result.current.data?.proposalGeneration?.status).toBe('ready'));
    const callsAfterReady = (global.fetch as jest.Mock).mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(12_000);
    });
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterReady);
  });

  it('polls while evaluation is running and stops once it completes', async () => {
    jest.useFakeTimers();
    const payload = (aiStatus: string, status: string) => ({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'rfp-1', aiStatus, status, proposalGeneration: null }),
    });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(payload('evaluating', 'evaluating'))
      .mockResolvedValue(payload('complete', 'evaluated')) as jest.Mock;
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRfpTriageDetail('rfp-1', true), { wrapper });

    await waitFor(() => expect(result.current.data?.aiStatus).toBe('evaluating'));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(result.current.data?.status).toBe('evaluated'));
    const callsAfterComplete = (global.fetch as jest.Mock).mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsAfterComplete);
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

describe('useRfpQueue / useRfpStatusTransition', () => {
  beforeEach(() => jest.clearAllMocks());

  it('PBI-005 AC-0 loads the triage queue with status and verdict filters', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items: [{ id: 'rfp-1', title: 'One' }], total: 1 }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useRfpQueue({ status: 'evaluated', verdict: 'build', q: 'intake', page: 0, enabled: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/triage/requests?limit=50&offset=0&status=evaluated&verdict=build&q=intake',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('PBI-005 AC-1 surfaces the error and keeps the mutation unsuccessful', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ error: 'Invalid status transition' }),
    }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRfpStatusTransition(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: 'rfp-1', target: 'accepted' });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/invalid status transition/i);
  });
});
