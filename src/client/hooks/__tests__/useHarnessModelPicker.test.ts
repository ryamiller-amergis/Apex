import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useHarnessModelPicker } from '../useHarnessModelPicker';
import { DEFAULT_MODEL_ID } from '../../config/models';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper };
}

const MODELS = [
  { id: 'composer-2.5', displayName: 'Composer 2.5' },
  { id: 'claude-x', displayName: 'Claude X' },
];

function mockApi(globalDefault: string | null) {
  global.fetch = jest.fn(async (url: string) => {
    if (url.includes('/api/available-models')) {
      return { ok: true, status: 200, json: async () => ({ models: MODELS }) };
    }
    if (url.includes('/api/admin/app-settings/defaultModel')) {
      return { ok: true, status: 200, json: async () => ({ key: 'defaultModel', value: globalDefault }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as jest.Mock;
}

describe('useHarnessModelPicker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('starts at the built-in default and lists the available models', async () => {
    mockApi(null);
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHarnessModelPicker(), { wrapper });

    expect(result.current.model).toBe(DEFAULT_MODEL_ID);
    await waitFor(() => expect(result.current.models).toHaveLength(2));
    expect(result.current.modelsLoading).toBe(false);
  });

  it('adopts the admin default once it loads', async () => {
    mockApi('claude-x');
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHarnessModelPicker(), { wrapper });

    await waitFor(() => expect(result.current.model).toBe('claude-x'));
  });

  it('prefers the thread model over the admin default', async () => {
    mockApi('claude-x');
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useHarnessModelPicker('composer-2.5'), { wrapper });

    expect(result.current.model).toBe('composer-2.5');
    await waitFor(() => expect(result.current.models).toHaveLength(2));
    expect(result.current.model).toBe('composer-2.5');
  });

  it('keeps a user pick until the preferred model changes', async () => {
    mockApi('claude-x');
    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ thread }: { thread: string | null }) => useHarnessModelPicker(thread),
      { wrapper, initialProps: { thread: null as string | null } },
    );
    await waitFor(() => expect(result.current.model).toBe('claude-x'));

    act(() => result.current.onModelChange('composer-2.5'));
    expect(result.current.model).toBe('composer-2.5');

    rerender({ thread: null });
    expect(result.current.model).toBe('composer-2.5');

    rerender({ thread: 'claude-x' });
    await waitFor(() => expect(result.current.model).toBe('claude-x'));
  });
});
