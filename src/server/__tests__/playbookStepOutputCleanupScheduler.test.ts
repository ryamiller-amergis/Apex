import {
  createPlaybookStepOutputCleanupScheduler,
  PLAYBOOK_OUTPUT_CLEANUP_INTERVAL_MS,
} from '../services/playbookStepOutputCleanupScheduler';

describe('Playbook step-output cleanup scheduler', () => {
  it('runs one pass per day and skips an overlapping pass', async () => {
    jest.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = jest.fn(() => gate.then(() => ({
      checkedReferences: 0,
      danglingReferences: [],
      deletedOrphans: [],
    })));
    const scheduler = createPlaybookStepOutputCleanupScheduler({ reconcile });

    scheduler.start();
    const first = scheduler.runNow();
    await Promise.resolve();
    await expect(scheduler.runNow()).resolves.toBe(false);
    release();
    await expect(first).resolves.toBe(true);

    await jest.advanceTimersByTimeAsync(PLAYBOOK_OUTPUT_CLEANUP_INTERVAL_MS);
    release();
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(2);

    scheduler.stop();
    jest.useRealTimers();
  });
});
