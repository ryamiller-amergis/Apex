/**
 * FEAT-005 / PBI-005 — useWalkthroughEligibility
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWalkthroughEligibility } from '../useWalkthroughEligibility';

const trackEvent = jest.fn();
jest.mock('../../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  trackEvent.mockReset();
  global.fetch = jest.fn();
});

describe('useWalkthroughEligibility (PBI-005)', () => {
  it('AC-0: returns the single eligible Walkthrough candidate', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        walkthrough: {
          id: 'wt-1',
          userTitle: 'Intro',
          revision: 1,
          priority: 5,
          steps: [],
        },
      }),
    });

    const { result } = renderHook(
      () => useWalkthroughEligibility({ projectId: 'Apex', userId: 'user-1' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSettled).toBe(true));
    expect(result.current.candidate?.id).toBe('wt-1');
    expect(result.current.isError).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/Apex/walkthroughs/next',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('AC-1: failed eligibility settles with null candidate (fail-closed)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });

    const { result } = renderHook(
      () => useWalkthroughEligibility({ projectId: 'Apex', userId: 'user-1' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSettled).toBe(true));
    expect(result.current.candidate).toBeNull();
    expect(result.current.isError).toBe(true);
  });

  it('AC-3: null walkthrough envelope yields no candidate', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ walkthrough: null }),
    });

    const { result } = renderHook(
      () => useWalkthroughEligibility({ projectId: 'Apex', userId: 'user-1' }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSettled).toBe(true));
    expect(result.current.candidate).toBeNull();
    expect(result.current.isError).toBe(false);
  });
});
