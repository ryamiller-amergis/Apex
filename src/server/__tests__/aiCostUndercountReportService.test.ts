import {
  LATEST_UNDERCOUNT_REPORT_SETTING,
  createAiCostUndercountReportService,
} from '../services/aiCostUndercountReportService';

describe('TBI-050 daily read-only undercount measurement', () => {
  it('reports estimated-zero share, unknown volume, key presence, and fallback input', async () => {
    const saveSetting = jest.fn();
    const emit = jest.fn();
    const readMetrics = jest.fn().mockResolvedValue({
      totalUsageEvents: 20,
      estimatedZeroCostEvents: 5,
      unknownProjectEvents: 3,
      unknownProjectCostUsd: 1.25,
    });
    const service = createAiCostUndercountReportService({
      readMetrics,
      getSetting: jest.fn().mockResolvedValue('30.000000'),
      saveSetting,
      environment: () => 'dev',
      cursorTeamApiKeyPresent: () => false,
      emit,
      now: () => new Date('2026-09-22T16:00:00.000Z'),
    });

    const report = await service.run();

    expect(report).toEqual(
      expect.objectContaining({
        environment: 'dev',
        estimatedZeroCostShare: 0.25,
        unknownProjectEvents: 3,
        unknownProjectCostUsd: 1.25,
        cursorTeamApiKeyPresent: false,
        defaultNoHistoryCapUsd: '30.000000',
      })
    );
    expect(readMetrics).toHaveBeenCalledTimes(1);
    expect(saveSetting).toHaveBeenCalledWith(
      LATEST_UNDERCOUNT_REPORT_SETTING,
      expect.stringContaining('"estimatedZeroCostShare":0.25')
    );
    expect(emit).toHaveBeenCalledWith(report);
  });
});
