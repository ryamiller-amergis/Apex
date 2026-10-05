import { act, renderHook } from '@testing-library/react';
import { useCloudAgentActivityStream } from '../useDevWorkbench';

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    writable: true,
    value: MockEventSource,
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'EventSource');
});

describe('useCloudAgentActivityStream', () => {
  it('opens the run-scoped stream and removes replay duplicates', () => {
    const { result } = renderHook(() =>
      useCloudAgentActivityStream('session-1', 'run-1', true));
    const source = MockEventSource.instances[0];

    expect(source.url).toBe(
      '/api/dev-workbench/sessions/session-1/cloud-agent/stream?runId=run-1',
    );
    expect(source.withCredentials).toBe(true);

    const activity = {
      type: 'activity',
      event: {
        id: '1:assistant:0',
        kind: 'assistant',
        title: 'Agent update',
        detail: 'Updating the route.',
      },
    };
    act(() => {
      source.onopen?.();
      source.emit(activity);
      source.emit(activity);
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].detail).toBe('Updating the route.');
  });

  it('closes after the server finishes replaying the run', () => {
    const { result } = renderHook(() =>
      useCloudAgentActivityStream('session-1', 'run-1', true));
    const source = MockEventSource.instances[0];

    act(() => {
      source.onopen?.();
      source.emit({ type: 'stream_end' });
    });

    expect(source.closed).toBe(true);
    expect(result.current.isConnected).toBe(false);
  });

  it('does not connect until the run can be streamed', () => {
    renderHook(() => useCloudAgentActivityStream('session-1', 'run-1', false));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
