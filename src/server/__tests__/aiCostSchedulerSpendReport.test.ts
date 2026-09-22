const runCursorBillingSync = jest.fn();
const runCostAllocation = jest.fn();
const generateBriefForAllProjects = jest.fn();
const runUndercountReport = jest.fn();
const isFeatureOperational = jest.fn().mockResolvedValue(true);

jest.mock('../services/cursorBillingSyncService', () => ({
  runCursorBillingSync,
}));
jest.mock('../services/aiCostAllocationService', () => ({ runCostAllocation }));
jest.mock('../services/aiCostDailyBriefService', () => ({
  generateBriefForAllProjects,
}));
jest.mock('../services/aiCostUndercountReportService', () => ({
  aiCostUndercountReportService: { run: runUndercountReport },
}));
jest.mock('../services/featureFlagService', () => ({ isFeatureOperational }));

import { AiCostSchedulerService } from '../services/aiCostScheduler';

describe('TBI-050 scheduler cadence and flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T16:00:00.000Z'));
    runCostAllocation.mockResolvedValue(undefined);
    runUndercountReport.mockResolvedValue(undefined);
    isFeatureOperational.mockResolvedValue(true);
  });

  afterEach(() => jest.useRealTimers());

  it('runs the read-only report once per UTC day and again the next day', async () => {
    const scheduler = new AiCostSchedulerService();

    await (scheduler as unknown as { run(): Promise<void> }).run();
    await (scheduler as unknown as { run(): Promise<void> }).run();
    jest.setSystemTime(new Date('2026-09-23T16:00:00.000Z'));
    await (scheduler as unknown as { run(): Promise<void> }).run();

    expect(runUndercountReport).toHaveBeenCalledTimes(2);
  });

  it('does not run the report while the feature flag is off', async () => {
    isFeatureOperational.mockResolvedValue(false);
    const scheduler = new AiCostSchedulerService();

    await (scheduler as unknown as { run(): Promise<void> }).run();

    expect(runUndercountReport).not.toHaveBeenCalled();
  });
});
