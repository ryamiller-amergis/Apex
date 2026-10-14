import {
  createShutdownController,
  resolveShutdownDrainMs,
} from '../../services/aiRunsV2Worker/shutdownDrain';

describe('resolveShutdownDrainMs', () => {
  it('treats an unset value as abort at once', () => {
    expect(resolveShutdownDrainMs(undefined)).toBe(0);
    expect(resolveShutdownDrainMs('  ')).toBe(0);
  });

  it('accepts a non-negative integer', () => {
    expect(resolveShutdownDrainMs('570000')).toBe(570_000);
  });

  it.each(['-1', '1.5', 'ten'])('refuses %s', (raw) => {
    expect(() => resolveShutdownDrainMs(raw)).toThrow(
      /AI_RUNS_V2_SHUTDOWN_DRAIN_MS/
    );
  });
});

describe('createShutdownController', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('stops receiving at once and aborts the run in flight after the drain window', () => {
    const controller = createShutdownController(30_000);

    controller.shutdown();
    expect(controller.receiveSignal.aborted).toBe(true);
    expect(controller.executionSignal.aborted).toBe(false);

    jest.advanceTimersByTime(29_999);
    expect(controller.executionSignal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(controller.executionSignal.aborted).toBe(true);
  });

  it('aborts both at once when no drain window is set', () => {
    const controller = createShutdownController(0);

    controller.shutdown();

    expect(controller.receiveSignal.aborted).toBe(true);
    expect(controller.executionSignal.aborted).toBe(true);
  });

  it('aborts the run in flight on a second signal while draining', () => {
    const controller = createShutdownController(30_000);

    controller.shutdown();
    controller.shutdown();

    expect(controller.executionSignal.aborted).toBe(true);
  });
});
