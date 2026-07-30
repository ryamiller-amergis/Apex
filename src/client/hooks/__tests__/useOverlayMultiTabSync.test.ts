import { act, renderHook, waitFor } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import { useOverlayMultiTabSync } from '../useOverlayMultiTabSync';

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  postMessage = jest.fn();
  close = jest.fn();

  constructor(public readonly name: string) {
    MockBroadcastChannel.instances.push(this);
  }
}

const serverOverlay: OverlayTextBox = {
  id: 'server-overlay',
  pageId: 'page-1',
  x: 10,
  y: 10,
  width: 30,
  height: 10,
  text: 'Saved elsewhere',
  fontFamily: 'Helvetica',
  fontSize: 14,
  bold: false,
  italic: false,
  color: '#000000',
  horizontalAlign: 'left',
  verticalAlign: 'top',
  opacity: 100,
  rotation: 0,
  listStyle: 'none',
  zIndex: 1,
};

describe('useOverlayMultiTabSync', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: MockBroadcastChannel,
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
  });

  it('broadcasts a local save without showing a conflict', () => {
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState: jest.fn(),
        onAuthoritativeState: jest.fn(),
      })
    );

    act(() => result.current.onLocalSave('2026-07-21T12:01:00.000Z'));

    expect(MockBroadcastChannel.instances[0].postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'overlays-saved',
        updatedAt: '2026-07-21T12:01:00.000Z',
      })
    );
    expect(result.current.conflictVisible).toBe(false);
  });

  it('reloads and applies authoritative overlays for a newer foreign save', async () => {
    const loadAuthoritativeState = jest.fn().mockResolvedValue({
      overlays: [serverOverlay],
      updatedAt: '2026-07-21T12:02:00.000Z',
    });
    const onAuthoritativeState = jest.fn();
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState,
        onAuthoritativeState,
      })
    );

    act(() => {
      MockBroadcastChannel.instances[0].onmessage?.({
        data: {
          type: 'overlays-saved',
          tabId: 'another-tab',
          updatedAt: '2026-07-21T12:02:00.000Z',
        },
      } as MessageEvent);
    });

    await waitFor(() => expect(result.current.conflictVisible).toBe(true));
    expect(loadAuthoritativeState).toHaveBeenCalledTimes(1);
    expect(onAuthoritativeState).toHaveBeenCalledWith({
      overlays: [serverOverlay],
      updatedAt: '2026-07-21T12:02:00.000Z',
    });

    act(() => result.current.acknowledge());
    expect(result.current.conflictVisible).toBe(false);
  });

  it('ignores foreign notifications that are not newer', () => {
    const loadAuthoritativeState = jest.fn();
    renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:02:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState,
        onAuthoritativeState: jest.fn(),
      })
    );

    act(() => {
      MockBroadcastChannel.instances[0].onmessage?.({
        data: {
          type: 'overlays-saved',
          tabId: 'another-tab',
          updatedAt: '2026-07-21T12:01:00.000Z',
        },
      } as MessageEvent);
    });

    expect(loadAuthoritativeState).not.toHaveBeenCalled();
  });

  it('keeps the single-tab visibility check quiet when nothing is newer', async () => {
    const loadAuthoritativeState = jest.fn().mockResolvedValue({
      overlays: [],
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState,
        onAuthoritativeState: jest.fn(),
      })
    );

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() => expect(loadAuthoritativeState).toHaveBeenCalled());
    expect(result.current.conflictVisible).toBe(false);
    expect(result.current.isReloading).toBe(false);
  });

  it('does not report a tab conflict when only the session timestamp changed', async () => {
    const loadAuthoritativeState = jest.fn().mockResolvedValue({
      overlays: [serverOverlay],
      updatedAt: '2026-07-21T12:01:00.000Z',
    });
    const onAuthoritativeState = jest.fn();
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [serverOverlay],
        loadAuthoritativeState,
        onAuthoritativeState,
      })
    );

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    await waitFor(() => expect(loadAuthoritativeState).toHaveBeenCalled());
    expect(onAuthoritativeState).not.toHaveBeenCalled();
    expect(result.current.conflictVisible).toBe(false);
  });

  it('does not run a visibility reload over unsaved local changes', () => {
    const loadAuthoritativeState = jest.fn();
    renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [serverOverlay],
        hasLocalChanges: true,
        loadAuthoritativeState,
        onAuthoritativeState: jest.fn(),
      })
    );

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(loadAuthoritativeState).not.toHaveBeenCalled();
  });

  it('rejects a delayed local response older than known server state', async () => {
    const loadAuthoritativeState = jest.fn().mockResolvedValue({
      overlays: [serverOverlay],
      updatedAt: '2026-07-21T12:02:00.000Z',
    });
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState,
        onAuthoritativeState: jest.fn(),
      })
    );
    act(() => {
      MockBroadcastChannel.instances[0].onmessage?.({
        data: {
          type: 'overlays-saved',
          tabId: 'another-tab',
          updatedAt: '2026-07-21T12:02:00.000Z',
        },
      } as MessageEvent);
    });
    await waitFor(() => expect(result.current.conflictVisible).toBe(true));

    let accepted = true;
    act(() => {
      accepted = result.current.onLocalSave('2026-07-21T12:01:00.000Z');
    });

    expect(accepted).toBe(false);
    await waitFor(() =>
      expect(loadAuthoritativeState).toHaveBeenCalledTimes(2)
    );
  });

  it('surfaces a reload error and retries the authoritative load', async () => {
    const loadAuthoritativeState = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce({
        overlays: [serverOverlay],
        updatedAt: '2026-07-21T12:02:00.000Z',
      });
    const onAuthoritativeState = jest.fn();
    const { result } = renderHook(() =>
      useOverlayMultiTabSync({
        sessionId: 'session-1',
        initialUpdatedAt: '2026-07-21T12:00:00.000Z',
        currentOverlays: [],
        loadAuthoritativeState,
        onAuthoritativeState,
      })
    );

    act(() => {
      MockBroadcastChannel.instances[0].onmessage?.({
        data: {
          type: 'overlays-saved',
          tabId: 'another-tab',
          updatedAt: '2026-07-21T12:02:00.000Z',
        },
      } as MessageEvent);
    });
    await waitFor(() =>
      expect(result.current.errorMessage).toMatch(/network unavailable/i)
    );

    await act(async () => result.current.retry());

    expect(onAuthoritativeState).toHaveBeenCalledWith({
      overlays: [serverOverlay],
      updatedAt: '2026-07-21T12:02:00.000Z',
    });
    expect(result.current.errorMessage).toBeNull();
  });
});
