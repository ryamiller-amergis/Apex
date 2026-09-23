import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useUiLabStream } from '../useUiLab';

class FakeEventSource {
  static latest: FakeEventSource | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close = jest.fn();

  constructor(public readonly url: string) {
    FakeEventSource.latest = this;
  }

  emit(data: unknown, lastEventId = ''): void {
    this.onmessage?.({
      data: JSON.stringify(data),
      lastEventId,
    } as MessageEvent);
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={client}>
      {children}
    </QueryClientProvider>
  );
}

describe('useUiLabStream reconnect behavior', () => {
  beforeEach(() => {
    FakeEventSource.latest = null;
    global.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  it('keeps a V2 EventSource open so the browser can reconnect and replay', () => {
    const { result } = renderHook(() => useUiLabStream(), { wrapper });
    act(() => result.current.startStream('design-1', 'generate'));
    const source = FakeEventSource.latest!;

    act(() => {
      source.emit({ type: 'transport', transport: 'v2' });
      source.emit(
        { type: 'token', text: '<html>' },
        '3f44f6f1-ec42-4aa6-9df4-0d8ce8438491',
      );
      source.onerror?.();
    });

    expect(source.close).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('streaming');
    expect(result.current.streamedHtml).toBe('<html>');
    expect(result.current.error).toBeNull();
  });

  it('preserves the V1 connection-loss error behavior', () => {
    const { result } = renderHook(() => useUiLabStream(), { wrapper });
    act(() => result.current.startStream('design-1', 'generate'));
    const source = FakeEventSource.latest!;

    act(() => {
      source.emit({ type: 'transport', transport: 'v1' });
      source.onerror?.();
    });

    expect(source.close).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('Connection lost during generation');
  });

  it('ignores a durable token event replayed with the same id', () => {
    const { result } = renderHook(() => useUiLabStream(), { wrapper });
    act(() => result.current.startStream('design-1', 'generate'));
    const source = FakeEventSource.latest!;
    const eventId = '3f44f6f1-ec42-4aa6-9df4-0d8ce8438491';

    act(() => {
      source.emit({ type: 'transport', transport: 'v2' });
      source.emit({ type: 'token', text: '<html>' }, eventId);
      source.emit({ type: 'token', text: '<html>' }, eventId);
    });

    expect(result.current.streamedHtml).toBe('<html>');
  });
});
