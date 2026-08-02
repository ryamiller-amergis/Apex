import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { WalkthroughDefinition } from '../../../shared/types/walkthrough';
import { useGuidedWalkthrough } from '../useGuidedWalkthrough';

const trackEvent = jest.fn();
jest.mock('../../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

const reshowRevision: WalkthroughDefinition = {
  id: 'wt-high-priority',
  internalName: 'updated-intro',
  userTitle: 'Updated intro',
  whyItMatters: 'New behavior',
  lifecycle: 'published',
  priority: 100,
  isRequired: false,
  revision: 2,
  publishedAt: '2026-08-02T12:00:00Z',
  archivedAt: null,
  createdBy: 'admin',
  createdAt: '2026-08-01T12:00:00Z',
  updatedBy: 'admin',
  updatedAt: '2026-08-02T12:00:00Z',
  steps: [],
  targeting: { projects: ['Apex'], groupId: null },
  targetingRules: [{ type: 'project', value: 'Apex' }],
};

function createWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function renderGuided(client: QueryClient) {
  return renderHook(
    () =>
      useGuidedWalkthrough({
        projectId: 'Apex',
        userId: 'user-1',
        whatsNewSettled: true,
        whatsNewBlocksWalkthrough: false,
      }),
    { wrapper: createWrapper(client) },
  );
}

describe('useGuidedWalkthrough project entry', () => {
  beforeEach(() => {
    trackEvent.mockReset();
    global.fetch = jest.fn();
  });

  it('refetches cached eligibility and auto-launches a re-show revision on same-project re-entry', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ walkthrough: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ walkthrough: reshowRevision }),
      });

    const firstEntry = renderGuided(client);
    await waitFor(() => {
      expect(trackEvent).toHaveBeenCalledWith(
        'walkthrough.auto_launch_suppressed',
        expect.objectContaining({ reason: 'no_candidate' }),
      );
    });
    firstEntry.unmount();

    const returnEntry = renderGuided(client);
    await waitFor(() => expect(returnEntry.result.current.activeDefinition).toEqual(reshowRevision));

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(trackEvent).toHaveBeenCalledWith(
      'walkthrough.auto_launched',
      expect.objectContaining({
        walkthroughId: 'wt-high-priority',
        revision: '2',
      }),
    );
  });

  it('refetches on re-entry but keeps a silent update suppressed', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ walkthrough: null }),
    });

    const firstEntry = renderGuided(client);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    firstEntry.unmount();
    trackEvent.mockClear();

    const returnEntry = renderGuided(client);
    await waitFor(() => {
      expect(trackEvent).toHaveBeenCalledWith(
        'walkthrough.auto_launch_suppressed',
        expect.objectContaining({ reason: 'no_candidate' }),
      );
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(returnEntry.result.current.activeDefinition).toBeNull();
    expect(trackEvent).not.toHaveBeenCalledWith(
      'walkthrough.auto_launched',
      expect.anything(),
    );
  });
});
