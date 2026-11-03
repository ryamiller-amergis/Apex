/**
 * TBI-015 DoD-3; PBI-016 AC-1 / VT-16. Retry timers are scheduled only after each failed fetch
 * settles, so fake time must advance in small steps; one large jump skips the retries.
 */
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuildApiError, useBuild } from '../useBuilds';

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function detail(status: 'building' | 'checking') {
  return { build: { id: 'b1', project: 'Apex', status, intakeInterviewId: null } };
}

/** Steps fake time one second at a time until `done` holds, so each retry timer gets scheduled. */
async function stepUntil(done: () => boolean, maxSeconds = 20) {
  for (let second = 0; second < maxSeconds && !done(); second += 1) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1_000);
    });
  }
}

afterEach(() => {
  jest.useRealTimers();
});

it('VT-16 TBI-015 DoD-3 keeps previous data after a failed refresh and refetches on a later interval', async () => {
  jest.useFakeTimers();
  let mode: 'ok' | 'fail' | 'next' = 'ok';
  global.fetch = jest.fn(() => Promise.resolve(
    mode === 'fail'
      ? response(500, { error: 'boom' })
      : response(200, detail(mode === 'ok' ? 'building' : 'checking')),
  )) as unknown as typeof fetch;
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  const { result } = renderHook(() => useBuild('Apex', 'b1'), { wrapper });
  await waitFor(() => expect(result.current.data?.build.status).toBe('building'));

  mode = 'fail';
  await stepUntil(() => result.current.isRefetchError);
  expect(result.current.isRefetchError).toBe(true);
  expect(result.current.data?.build.status).toBe('building');
  expect(result.current.error).toBeInstanceOf(BuildApiError);
  expect((result.current.error as BuildApiError).status).toBe(500);

  mode = 'next';
  await stepUntil(() => result.current.data?.build.status === 'checking');
  expect(result.current.data?.build.status).toBe('checking');
  expect(result.current.isRefetchError).toBe(false);
});
