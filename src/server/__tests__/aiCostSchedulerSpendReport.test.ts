const runCursorBillingSync = jest.fn();
const runCostAllocation = jest.fn();
const generateBriefForAllProjects = jest.fn();
const runUndercountReport = jest.fn();

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

import { AiCostSchedulerService } from '../services/aiCostScheduler';

describe('TBI-050 scheduler cadence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-09-22T16:00:00.000Z'));
    runCostAllocation.mockResolvedValue(undefined);
    runUndercountReport.mockResolvedValue(undefined);
    generateBriefForAllProjects.mockResolvedValue(undefined);
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

  it('runs the report on the daily cadence without a feature flag', async () => {
    const scheduler = new AiCostSchedulerService();

    await (scheduler as unknown as { run(): Promise<void> }).run();

    expect(runUndercountReport).toHaveBeenCalledTimes(1);
  });

  it('keeps the established daily brief running when the Playbook report fails', async () => {
    jest.setSystemTime(new Date(2026, 8, 22, 8, 0, 0));
    runUndercountReport.mockRejectedValue(new Error('report unavailable'));
    const scheduler = new AiCostSchedulerService();

    await (scheduler as unknown as { run(): Promise<void> }).run();

    expect(generateBriefForAllProjects).toHaveBeenCalledWith('morning');
  });
});
