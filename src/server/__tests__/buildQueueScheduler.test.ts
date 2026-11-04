import { BUILD_QUEUE_INTERVAL_MS, runBuildQueueSweep } from '../services/buildQueueScheduler';

describe('build queue scheduler (VT-14)', () => {
  it('waits 10 seconds between sweeps and does nothing when the flag is off', async () => {
    expect(BUILD_QUEUE_INTERVAL_MS).toBe(10_000);
    const promote = jest.fn();
    await runBuildQueueSweep({ isOperational: async () => false, promote });
    expect(promote).not.toHaveBeenCalled();
    await runBuildQueueSweep({ isOperational: async () => true, promote });
    await runBuildQueueSweep({ isOperational: async () => true, promote });
    expect(promote).toHaveBeenCalledTimes(2);
  });
});
