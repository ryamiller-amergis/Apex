import { act, renderHook } from '@testing-library/react';
import { RUN_STALLED_AFTER_MS, useRunStalled } from '../useRunStalled';

describe('useRunStalled', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-03T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a stall after 30 seconds with no progress and clears on new progress', () => {
    const { result, rerender } = renderHook(
      ({ active, lastProgressAt }) => useRunStalled(active, lastProgressAt),
      { initialProps: { active: true, lastProgressAt: Date.now() as number | null } },
    );
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(RUN_STALLED_AFTER_MS);
    });
    expect(result.current).toBe(true);

    rerender({ active: true, lastProgressAt: Date.now() });
    expect(result.current).toBe(false);
  });

  it('counts from the start of the run, not a previous turn', () => {
    const previousTurn = Date.now() - 10 * 60_000;
    const { result } = renderHook(() => useRunStalled(true, previousTurn));
    expect(result.current).toBe(false);

    act(() => {
      jest.advanceTimersByTime(RUN_STALLED_AFTER_MS - 5_000);
    });
    expect(result.current).toBe(false);
  });

  it('is never stalled while the run is inactive', () => {
    const { result } = renderHook(() => useRunStalled(false, Date.now() - 60_000));
    act(() => {
      jest.advanceTimersByTime(RUN_STALLED_AFTER_MS * 2);
    });
    expect(result.current).toBe(false);
  });
});
