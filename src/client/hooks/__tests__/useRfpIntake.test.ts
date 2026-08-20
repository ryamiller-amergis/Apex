import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMyRfpRequests, useRfpRequestDetail, useSubmitRfpRequest } from '../useRfpIntake';
import type { CreateRfpRequestDTO, RfpOwnerListResponse } from '../../../shared/types/rfpIntake';

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

function mockFetchOk(data: unknown, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    json: () => Promise.resolve(data),
  }) as jest.Mock;
}

function mockFetchError(status: number, body: unknown = { error: `HTTP ${status}` }) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }) as jest.Mock;
}

const INTAKE: CreateRfpRequestDTO = {
  title: 'Internal intake tracker',
  stakeholder: 'BA team',
  request: 'Track RFPs',
  problem: 'Fragmented',
  audience: 'internal',
  dataSensitivity: 'internal-only',
  existingSolution: 'none',
};

describe('useSubmitRfpRequest VT-02 PBI-003 AC-1', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-02 AC-1 rolls back the optimistic Evaluating row when create fails', async () => {
    mockFetchError(500, { error: 'create failed' });
    const { wrapper, queryClient } = createWrapper();
    queryClient.setQueryData<RfpOwnerListResponse>(['rfp-intake', 'mine', 0], {
      items: [],
      total: 0,
    });

    const { result } = renderHook(() => useSubmitRfpRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({ intake: INTAKE, files: [] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const cached = queryClient.getQueryData<RfpOwnerListResponse>(['rfp-intake', 'mine', 0]);
    expect(cached?.items.some((row) => row.id.startsWith('optimistic-'))).toBe(false);
    expect(cached?.items).toHaveLength(0);
  });

  it('adds an optimistic Evaluating row on submit', async () => {
    let resolveFetch: ((value: unknown) => void) | undefined;
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = (data: unknown) =>
            resolve({ ok: true, status: 201, json: () => Promise.resolve(data) });
        }),
    ) as jest.Mock;

    const { wrapper, queryClient } = createWrapper();
    const { result } = renderHook(() => useSubmitRfpRequest(), { wrapper });

    await act(async () => {
      result.current.mutate({ intake: INTAKE, files: [] });
    });

    await waitFor(() => {
      const cached = queryClient.getQueryData<RfpOwnerListResponse>(['rfp-intake', 'mine', 0]);
      expect(cached?.items[0]?.status).toBe('evaluating');
    });

    await act(async () => {
      resolveFetch?.({ id: 'rfp-1', ...INTAKE, status: 'evaluating', aiStatus: 'evaluating' });
    });
  });
});

describe('useRfpRequestDetail VT-06 PBI-004 AC-1', () => {
  beforeEach(() => jest.clearAllMocks());

  it('VT-06 AC-1 surfaces an error without a successful detail payload', async () => {
    mockFetchError(500, { error: 'detail failed' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRfpRequestDetail('rfp-1', true), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});

describe('useMyRfpRequests', () => {
  it('requests paginated owner rows', async () => {
    mockFetchOk({ items: [], total: 0 });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useMyRfpRequests(true, 1), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/rfp-intake/requests/mine?limit=50&offset=50',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});
