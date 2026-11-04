/**
 * PBI-023 AC-0..AC-3 / VT-29.
 */
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BuildVerificationMatrixResponse } from '../../../shared/types/buildView';
import {
  BuildApiError,
  useBuildEvidence,
  useBuildVerification,
} from '../useBuilds';

const BUILD_ID = 'b1';

const clients: QueryClient[] = [];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
    },
  });
  clients.push(queryClient);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function textResponse(status: number, textBody: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(textBody),
  };
}

function matrixFixture(overrides: Partial<BuildVerificationMatrixResponse> = {}): BuildVerificationMatrixResponse {
  return {
    buildId: BUILD_ID,
    revisionNumber: 2,
    revisionNumbers: [2, 1],
    summary: { total: 1, pass: 1, fail: 0, deferred: 0, retired: 0 },
    rows: [],
    ...overrides,
  };
}

let fetchMock: jest.Mock;
let visibilityStateValue: DocumentVisibilityState = 'visible';

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  visibilityStateValue = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityStateValue,
  });
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('useBuildVerification', () => {
  it('VT-29 PBI-023 AC-0: refetches every 5 seconds while running and stops after settle or while hidden', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, matrixFixture()));
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData(['build', 'Apex', BUILD_ID], {
      build: { id: BUILD_ID, project: 'Apex', status: 'building', intakeInterviewId: 'iv-1' },
    });

    const { result } = renderHook(() => useBuildVerification('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.data?.revisionNumber).toBe(2));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1/verification?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Hide the document tab: no refetch while hidden
    visibilityStateValue = 'hidden';
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Restore visibility and settle the run: no further polling
    visibilityStateValue = 'visible';
    queryClient.setQueryData(['build', 'Apex', BUILD_ID], {
      build: { id: BUILD_ID, project: 'Apex', status: 'preview_ready', intakeInterviewId: 'iv-1' },
    });
    await advance(15_000);
    const countAfterSettle = fetchMock.mock.calls.length;
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(countAfterSettle);
  });

  it('VT-29: passes the revision query parameter when specified', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, matrixFixture({ revisionNumber: 1 })));
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useBuildVerification('Apex', BUILD_ID, { revision: 1, buildStatus: 'accepted' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.revisionNumber).toBe(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1/verification?project=Apex&revision=1',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('VT-29: returns a typed BuildApiError on a 500 response', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'Internal failure', code: 'BUILD_VERIFICATION_FAILED' }));
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBuildVerification('Apex', BUILD_ID), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(BuildApiError);
    expect((result.current.error as BuildApiError).status).toBe(500);
    expect((result.current.error as BuildApiError).code).toBe('BUILD_VERIFICATION_FAILED');
  });
});

describe('useBuildEvidence', () => {
  it('VT-29 PBI-023 AC-0: stays idle when target is null and fetches plain text when given a target', async () => {
    fetchMock.mockResolvedValue(textResponse(200, 'FAIL src/foo.test.ts\nExpected 1 to be 2'));
    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ target }: { target: { rowId: string; slot: 'red' | 'green'; recordedAt?: string | null } | null }) =>
        useBuildEvidence('Apex', BUILD_ID, target),
      {
        wrapper,
        initialProps: {
          target: null as { rowId: string; slot: 'red' | 'green'; recordedAt?: string | null } | null,
        },
      },
    );

    await advance(5_000);
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ target: { rowId: 'row-1', slot: 'red', recordedAt: '2026-11-03T12:00:00.000Z' } });
    await waitFor(() => expect(result.current.data).toBe('FAIL src/foo.test.ts\nExpected 1 to be 2'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/builds/b1/evidence/row-1/red?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );

    // Evidence never polls
    await advance(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, 'Not available', 'BUILD_EVIDENCE_NOT_AVAILABLE'],
    [403, 'Forbidden', 'BUILD_FORBIDDEN'],
  ])('VT-29 PBI-023 AC-1 AC-3: surfaces %d as a typed BuildApiError without retrying', async (status, message, code) => {
    fetchMock.mockResolvedValue(jsonResponse(status, { error: message, code }));
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useBuildEvidence('Apex', BUILD_ID, { rowId: 'row-1', slot: 'red' }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(BuildApiError);
    expect((result.current.error as BuildApiError).status).toBe(status);
    expect((result.current.error as BuildApiError).code).toBe(code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
