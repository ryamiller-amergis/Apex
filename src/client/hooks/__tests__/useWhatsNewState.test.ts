/**
 * TBI-010 / PBI-009 — useWhatsNewState (VT-09–VT-11, VT-16–VT-17).
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WhatsNewState } from '../../../shared/types/whatsNew';

const trackEvent = jest.fn();
jest.mock('../../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => trackEvent(...args),
}));

jest.mock('../useChangelog', () => ({
  useChangelog: () => ({
    data: {
      currentVersion: '2.0.1',
      entries: [
        { version: '2.0.1', date: '2026-07-01', title: 'Latest', changes: [] },
        { version: '1.9.0', date: '2026-06-01', title: 'Prior', changes: [] },
      ],
    },
    isLoading: false,
    isError: false,
    isFetched: true,
  }),
}));

import { useWhatsNewState } from '../useWhatsNewState';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

const unreadBootstrap: WhatsNewState = {
  status: 'ready',
  currentVersion: '2.0.1',
  lastSeenVersion: '1.9.0',
  unread: true,
  showOnLogin: true,
  seeded: false,
};

beforeEach(() => {
  trackEvent.mockReset();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
});

describe('useWhatsNewState', () => {
  it('VT-09 / AC-2: auto preference off leaves proactive unread but does not auto-open', async () => {
    const bootstrap = { ...unreadBootstrap, showOnLogin: false };
    const { result } = renderHook(() => useWhatsNewState({ bootstrap }), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.unread).toBe(true);
    expect(result.current.proactive).toBe(true);
    expect(result.current.isOpen).toBe(false);
  });

  it('VT-10 / AC-4: dismiss clears unread optimistically and writes captured version', async () => {
    const { result } = renderHook(() => useWhatsNewState({ bootstrap: unreadBootstrap }), { wrapper });
    await waitFor(() => expect(result.current.proactive).toBe(true));

    await act(async () => {
      result.current.dismiss('modal');
    });

    expect(result.current.unread).toBe(false);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ lastSeenVersion: '2.0.1' }),
      }),
    );
  });

  it('VT-11 / AC-1: acknowledgement failure keeps optimistic clear and emits failure event', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const { result } = renderHook(() => useWhatsNewState({ bootstrap: unreadBootstrap }), { wrapper });
    await waitFor(() => expect(result.current.proactive).toBe(true));

    await act(async () => {
      result.current.dismiss('banner');
    });

    await waitFor(() => {
      expect(trackEvent).toHaveBeenCalledWith(
        'whats_new.acknowledgement_failed',
        expect.objectContaining({ version: '2.0.1', surface: 'banner' }),
      );
    });
    expect(result.current.unread).toBe(false);
  });

  it('VT-16 / TC-007: telemetry props are allowlisted (no PII keys)', async () => {
    const bootstrap = { ...unreadBootstrap, showOnLogin: false };
    const { result } = renderHook(() => useWhatsNewState({ bootstrap }), { wrapper });
    await waitFor(() => expect(result.current.proactive).toBe(true));

    await act(async () => {
      result.current.open('manual');
    });

    const opened = trackEvent.mock.calls.find(
      (c) => c[0] === 'whats_new.modal_opened' && c[1]?.mode === 'manual',
    );
    expect(opened?.[1]).toEqual({ version: '2.0.1', mode: 'manual' });
    expect(opened?.[1]).not.toHaveProperty('email');
    expect(opened?.[1]).not.toHaveProperty('bio');
  });

  it('VT-17 / TC-008: bootstrap snapshot is taken once — project changes do not re-bind', async () => {
    const { result, rerender } = renderHook(
      ({ bootstrap }) => useWhatsNewState({ bootstrap }),
      { wrapper, initialProps: { bootstrap: unreadBootstrap } },
    );
    await waitFor(() => expect(result.current.currentVersion).toBe('2.0.1'));

    rerender({
      bootstrap: {
        ...unreadBootstrap,
        currentVersion: '9.9.9',
        unread: false,
      },
    });

    expect(result.current.currentVersion).toBe('2.0.1');
    expect(result.current.unread).toBe(true);
  });
});
