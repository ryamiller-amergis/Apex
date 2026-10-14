jest.mock('../services/cloudAgentService', () => ({
  pumpCloudAgentQueue: jest.fn().mockResolvedValue(undefined),
  reconcileRunningCloudAgentRuns: jest.fn().mockResolvedValue(undefined),
}));

import {
  startCloudAgentQueueScheduler,
  stopCloudAgentQueueScheduler,
} from '../services/cloudAgentQueueScheduler';
import {
  pumpCloudAgentQueue,
  reconcileRunningCloudAgentRuns,
} from '../services/cloudAgentService';

const reconcile = reconcileRunningCloudAgentRuns as jest.Mock;
const pump = pumpCloudAgentQueue as jest.Mock;

describe('cloud agent queue scheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    stopCloudAgentQueueScheduler();
    reconcile.mockClear();
    pump.mockClear();
    reconcile.mockResolvedValue(undefined);
    pump.mockResolvedValue(undefined);
  });

  afterEach(() => {
    stopCloudAgentQueueScheduler();
    jest.useRealTimers();
  });

  it('finishes closed-page executions before starting queued runs', async () => {
    startCloudAgentQueueScheduler();
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(pump).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(pump.mock.invocationCallOrder[0]);
  });

  it('sweeps again on the interval and stops when the scheduler stops', async () => {
    startCloudAgentQueueScheduler();
    startCloudAgentQueueScheduler();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(pump).toHaveBeenCalledTimes(2);

    stopCloudAgentQueueScheduler();
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
