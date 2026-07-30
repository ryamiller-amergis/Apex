/**
 * FEAT-011 / PBI-014 client hook — useLoadTestAiGenerate
 *
 * AC-0: start → pending → ready surfaces script + suggested_thresholds
 * AC-1: generation failure surfaces an error without throwing
 * NFR: cancel stops polling and calls the cancel endpoint
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { useLoadTestAiGenerate } from '../useLoadTestAiGenerate';

jest.mock('../useChatStream', () => ({
  useChatStream: jest.fn(() => ({
    streamingText: '',
    progressLabel: null,
    status: 'idle',
  })),
}));

const PROJECT = 'project-a';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ legacyFakeTimers: false });
  global.fetch = jest.fn() as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('useLoadTestAiGenerate', () => {
  it('AC-0: start → pending → polls result → ready with script + suggested_thresholds', async () => {
    const mockedFetch = global.fetch as jest.Mock;
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ threadId: 'thread-1' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'pending' }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'ready',
          result: {
            script: "export default function() {}",
            suggested_thresholds: [{ metric: 'http_req_duration', expression: 'p(95)<500' }],
          },
        }),
      );

    const { result } = renderHook(() => useLoadTestAiGenerate(PROJECT));

    await act(async () => {
      await result.current.start({ flowHints: 'login then browse' });
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/load-tests/ai-generate`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.status).toBe('pending');
    expect(result.current.isGenerating).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(1600);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.result?.script).toContain('export default function');
    expect(result.current.result?.suggested_thresholds).toEqual([
      { metric: 'http_req_duration', expression: 'p(95)<500' },
    ]);
    expect(result.current.isGenerating).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('AC-1: start failure (NO_REPO_CONNECTED) surfaces error without throwing', async () => {
    const mockedFetch = global.fetch as jest.Mock;
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'No connected repo', code: 'NO_REPO_CONNECTED' }, 409),
    );

    const { result } = renderHook(() => useLoadTestAiGenerate(PROJECT));

    await act(async () => {
      await result.current.start({ flowHints: 'login then browse' });
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toMatch(/no connected repo/i);
    expect(result.current.result).toBeNull();
  });

  it('AC-1: a failed status from polling surfaces the error and stops polling', async () => {
    const mockedFetch = global.fetch as jest.Mock;
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ threadId: 'thread-2' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'failed', error: 'Agent completed without generating a script.' }));

    const { result } = renderHook(() => useLoadTestAiGenerate(PROJECT));

    await act(async () => {
      await result.current.start({ flowHints: 'login then browse' });
    });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toMatch(/agent completed/i);
    expect(result.current.result).toBeNull();

    const callCountAtFailure = mockedFetch.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockedFetch.mock.calls.length).toBe(callCountAtFailure);
  });

  it('NFR cancel: stops polling and calls the cancel endpoint', async () => {
    const mockedFetch = global.fetch as jest.Mock;
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ threadId: 'thread-3' }, 202))
      .mockResolvedValueOnce(jsonResponse({ status: 'pending' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'cancelled' }));

    const { result } = renderHook(() => useLoadTestAiGenerate(PROJECT));

    await act(async () => {
      await result.current.start({ flowHints: 'login then browse' });
    });
    expect(result.current.status).toBe('pending');

    await act(async () => {
      await result.current.cancel();
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      `/api/projects/${PROJECT}/load-tests/ai-generate/thread-3/cancel`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.current.status).toBe('cancelled');

    const callCountAfterCancel = mockedFetch.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    expect(mockedFetch.mock.calls.length).toBe(callCountAfterCancel);
  });

  it('reset returns hook to idle and clears prior result/error', async () => {
    const mockedFetch = global.fetch as jest.Mock;
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ error: 'boom' }, 500),
    );

    const { result } = renderHook(() => useLoadTestAiGenerate(PROJECT));

    await act(async () => {
      await result.current.start({ flowHints: 'login then browse' });
    });
    expect(result.current.status).toBe('failed');

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(result.current.result).toBeNull();
  });
});
