/**
 * FEAT-004 / TBI-007 — useResolvedAvatar hook tests.
 * Criterion ids in names for Requirements → Test Matrix traceability.
 */
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fetchResolvedAvatar,
  resolvedAvatarQueryKey,
  useResolvedAvatar,
} from '../useProfiles';
import { buildAvatarResolverUrl } from '../../../shared/types/profile';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

describe('useProfiles — TBI-007 DoD-3 / NFR cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DoD-3 / VT-07: resolvedAvatarQueryKey includes oid and version', () => {
    expect(resolvedAvatarQueryKey('oid-a', 'v1')).toEqual([
      'resolved-avatar',
      'oid-a',
      'v1',
    ]);
    expect(resolvedAvatarQueryKey('oid-a', null)).toEqual([
      'resolved-avatar',
      'oid-a',
      '0',
    ]);
  });

  it('DoD-3: query is disabled without oid', () => {
    global.fetch = jest.fn();
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useResolvedAvatar('', 'v1'), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.isFetching).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('DoD-3 / VT-04: 401 throws without exposing Blob URL', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as jest.Mock;

    await expect(fetchResolvedAvatar('oid-b', 'v1')).rejects.toThrow(/not authenticated/i);
    expect(global.fetch).toHaveBeenCalledWith(
      buildAvatarResolverUrl('oid-b', 'v1'),
      expect.objectContaining({ credentials: 'include' })
    );
    const callUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(callUrl).not.toMatch(/blob\.core\.windows\.net/i);
  });

  it('DoD-0: 204 maps to initials fallback (no image bytes)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as jest.Mock;

    await expect(fetchResolvedAvatar('oid-b', '0')).resolves.toEqual({ kind: 'initials' });
  });

  it('DoD-0: 200 image bytes return kind image', async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === 'Content-Type' ? 'image/png' : null) },
      arrayBuffer: async () => buffer,
    }) as jest.Mock;

    const result = await fetchResolvedAvatar('oid-a', 'v2');
    expect(result).toEqual({ kind: 'image', buffer, contentType: 'image/png' });
  });

  it('VT-07: repeated mounts with same oid/version share one network request', async () => {
    const buffer = new Uint8Array([9]).buffer;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => buffer,
    }) as jest.Mock;

    const { wrapper, queryClient } = createWrapper();
    const { result: a } = renderHook(() => useResolvedAvatar('oid-a', 'v1'), { wrapper });
    const { result: b } = renderHook(() => useResolvedAvatar('oid-a', 'v1'), { wrapper });

    await waitFor(() => expect(a.current.isSuccess).toBe(true));
    await waitFor(() => expect(b.current.isSuccess).toBe(true));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(resolvedAvatarQueryKey('oid-a', 'v1'))).toEqual({
      kind: 'image',
      buffer,
      contentType: 'image/png',
    });
  });

  it('VT-07: version change uses a new cache entry and refetches', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        arrayBuffer: async () => new Uint8Array([2]).buffer,
      }) as jest.Mock;

    const { wrapper } = createWrapper();
    const { result, rerender } = renderHook(
      ({ version }: { version: string }) => useResolvedAvatar('oid-a', version),
      { wrapper, initialProps: { version: 'v1' } }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ version: 'v2' });
    await waitFor(() =>
      expect(result.current.data).toEqual(
        expect.objectContaining({ kind: 'image' })
      )
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
