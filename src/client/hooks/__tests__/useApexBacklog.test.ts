import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useApexBacklogFeatures, useApexFeatureContext } from '../useApexBacklog';
import type { ApexFeatureContextResponse } from '../../../shared/types/devWorkbench';

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

const sampleContext: ApexFeatureContextResponse = {
  prdId: 'prd-1',
  prdTitle: 'Notifications',
  prdContent: '# PRD',
  epicTitle: 'Epic A',
  featureId: 'FEAT-001',
  featureTitle: 'Preferences',
  featurePriority: 'Must',
  backlogItems: [],
  designDocument: null,
  prototype: null,
};

describe('useApexBacklogFeatures', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not fetch when project is not Apex', () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useApexBacklogFeatures('MaxView'), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches backlog features for Apex', async () => {
    mockFetchOk([]);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useApexBacklogFeatures('Apex'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/backlog-features?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
  });
});

describe('useApexFeatureContext', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is disabled when project is not Apex', () => {
    mockFetchOk(sampleContext);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useApexFeatureContext('MaxView', 'prd-1', 'FEAT-001'),
      { wrapper },
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is disabled when prdId or featureId is missing', () => {
    mockFetchOk(sampleContext);
    const { wrapper } = createWrapper();
    const { result: missingPrd } = renderHook(
      () => useApexFeatureContext('Apex', null, 'FEAT-001'),
      { wrapper },
    );
    const { result: missingFeature } = renderHook(
      () => useApexFeatureContext('Apex', 'prd-1', null),
      { wrapper },
    );
    expect(missingPrd.current.fetchStatus).toBe('idle');
    expect(missingFeature.current.fetchStatus).toBe('idle');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('URL-encodes path and query parameters', async () => {
    mockFetchOk(sampleContext);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useApexFeatureContext('Apex', 'prd/with spaces', 'FEAT 001'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/dev-workbench/features/prd%2Fwith%20spaces/FEAT%20001/context?project=Apex',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('delivers the feature context response', async () => {
    mockFetchOk(sampleContext);
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useApexFeatureContext('Apex', 'prd-1', 'FEAT-001'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleContext);
  });

  it('propagates API errors', async () => {
    mockFetchError(404, { error: 'Approved PRD feature context not found' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(
      () => useApexFeatureContext('Apex', 'prd-1', 'FEAT-001'),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(
      expect.objectContaining({ message: 'Approved PRD feature context not found' }),
    );
  });
});
