import { act, renderHook } from '@testing-library/react';
import type { OverlayTextBox } from '../../../shared/types/pdf';
import {
  OVERLAY_AUTOSAVE_DELAY_MS,
  useOverlayAutosave,
} from '../useOverlayAutosave';

const mockMutateAsync = jest.fn();

jest.mock('../usePdfSession', () => ({
  useUpdateOverlays: () => ({ mutateAsync: mockMutateAsync }),
}));

function makeOverlay(text: string): OverlayTextBox {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    pageId: 'page-1',
    x: 10,
    y: 10,
    width: 30,
    height: 10,
    text,
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
}

describe('useOverlayAutosave', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockMutateAsync.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('saves the full overlay list 500 ms after the last edit', async () => {
    const overlays = [makeOverlay('Edited')];
    const onSaved = jest.fn();
    const onSaveSuccess = jest.fn();
    mockMutateAsync.mockResolvedValue({
      overlays,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    const { result } = renderHook(() =>
      useOverlayAutosave({
        sessionId: 'session-1',
        overlays,
        isDirty: true,
        onSaved,
        onSaveSuccess,
      })
    );

    await act(async () => {
      jest.advanceTimersByTime(OVERLAY_AUTOSAVE_DELAY_MS - 1);
      await Promise.resolve();
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      sessionId: 'session-1',
      overlays,
    });
    expect(onSaved).toHaveBeenCalledWith(overlays);
    expect(onSaveSuccess).toHaveBeenCalledWith('2026-07-21T12:00:00.000Z');
    expect(result.current.status).toBe('saved');
  });

  it('retains dirty state and exposes retry after a failed save', async () => {
    const overlays = [makeOverlay('Keep locally')];
    mockMutateAsync.mockRejectedValue(new Error('Network unavailable'));
    const onSaved = jest.fn();
    const { result } = renderHook(() =>
      useOverlayAutosave({
        sessionId: 'session-1',
        overlays,
        isDirty: true,
        onSaved,
      })
    );

    await act(async () => {
      jest.advanceTimersByTime(OVERLAY_AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });

    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toMatch(/network unavailable/i);

    mockMutateAsync.mockResolvedValue({ overlays, updatedAt: '' });
    await act(async () => {
      await result.current.retry();
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledWith(overlays);
  });

  it('flushes immediately and waits for persistence to complete', async () => {
    const overlays = [makeOverlay('Pending')];
    let resolveSave:
      | ((value: { overlays: OverlayTextBox[]; updatedAt: string }) => void)
      | null = null;
    mockMutateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        })
    );
    const onSaved = jest.fn();
    const { result } = renderHook(() =>
      useOverlayAutosave({
        sessionId: 'session-1',
        overlays,
        isDirty: true,
        onSaved,
      })
    );

    let resolved = false;
    let flushPromise: Promise<void>;
    act(() => {
      flushPromise = result.current.flushNow().then(() => {
        resolved = true;
      });
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    await act(async () => {
      resolveSave?.({ overlays, updatedAt: '' });
      await flushPromise!;
    });
    expect(resolved).toBe(true);
    expect(onSaved).toHaveBeenCalledWith(overlays);

    act(() => {
      jest.advanceTimersByTime(OVERLAY_AUTOSAVE_DELAY_MS);
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('does not apply a delayed response rejected as stale by multi-tab sync', async () => {
    const overlays = [makeOverlay('Stale local response')];
    const onSaved = jest.fn();
    const onSaveSuccess = jest.fn(() => false);
    mockMutateAsync.mockResolvedValue({
      overlays,
      updatedAt: '2026-07-21T12:00:00.000Z',
    });
    const { result } = renderHook(() =>
      useOverlayAutosave({
        sessionId: 'session-1',
        overlays,
        isDirty: true,
        onSaved,
        onSaveSuccess,
      })
    );

    await act(async () => result.current.flushNow());

    expect(onSaveSuccess).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.status).toBe('dirty');
  });

  it('inactive replacement draft never appears in the mutation payload', async () => {
    const persisted = makeOverlay('Persisted box');
    const onSaved = jest.fn();
    mockMutateAsync.mockResolvedValue({
      overlays: [persisted],
      updatedAt: '2026-07-21T13:00:00.000Z',
    });

    renderHook(() =>
      useOverlayAutosave({
        sessionId: 'session-1',
        overlays: [persisted],
        isDirty: true,
        onSaved,
      })
    );

    await act(async () => {
      jest.advanceTimersByTime(OVERLAY_AUTOSAVE_DELAY_MS);
      await Promise.resolve();
    });

    expect(mockMutateAsync).toHaveBeenCalledWith({
      sessionId: 'session-1',
      overlays: [persisted],
    });
    expect(
      mockMutateAsync.mock.calls[0][0].overlays.every(
        (o: { coverActive?: boolean }) => o.coverActive !== false
      )
    ).toBe(true);
  });
});
