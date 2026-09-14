import {
  getWorkItemCommentCount,
  getWorkItemCommentCounts,
  COMMENT_COUNT_BADGE_FEATURE,
} from '../services/workItemCommentCountService';
import type { AzureDevOpsService } from '../services/azureDevOps';

describe('workItemCommentCountService', () => {
  const createMockAdo = (count: number) =>
    ({
      getWorkItemCommentCount: jest.fn().mockResolvedValue(count),
    }) as unknown as AzureDevOpsService;

  it('returns success with positive count (VT-01)', async () => {
    const ado = createMockAdo(3);
    const result = await getWorkItemCommentCount(
      { createAdoService: () => ado },
      'MaxView',
      12345,
    );
    expect(result).toEqual({ status: 'success', count: 3 });
  });

  it('returns unavailable when count is zero (VT-02)', async () => {
    const ado = createMockAdo(0);
    const result = await getWorkItemCommentCount(
      { createAdoService: () => ado },
      'MaxView',
      12345,
    );
    expect(result).toEqual({ status: 'unavailable', count: null });
  });

  it('returns unavailable on HTTP error without throwing (VT-03)', async () => {
    const ado = {
      getWorkItemCommentCount: jest.fn().mockRejectedValue(new Error('500 Internal Server Error')),
    } as unknown as AzureDevOpsService;
    const result = await getWorkItemCommentCount(
      { createAdoService: () => ado },
      'MaxView',
      12345,
    );
    expect(result).toEqual({ status: 'unavailable', count: null });
  });

  it('logs structured warning on failure (VT-04, VT-20, VT-21)', async () => {
    const warn = jest.fn();
    const ado = {
      getWorkItemCommentCount: jest.fn().mockRejectedValue(new Error('429 Too Many Requests')),
    } as unknown as AzureDevOpsService;

    await getWorkItemCommentCount(
      {
        createAdoService: () => ado,
        logger: { warn },
      },
      'MaxView',
      99,
    );

    expect(warn).toHaveBeenCalledWith('ADO comment count fetch failed', {
      workItemId: 99,
      errorSummary: '429 Too Many Requests',
      feature: COMMENT_COUNT_BADGE_FEATURE,
    });
  });

  it('batch method returns map for multiple ids (VT-11)', async () => {
    const ado = {
      getWorkItemCommentCount: jest
        .fn()
        .mockImplementation(async (id: number) => (id === 1 ? 2 : 0)),
    } as unknown as AzureDevOpsService;

    const results = await getWorkItemCommentCounts(
      { createAdoService: () => ado },
      'MaxView',
      [1, 2, 2],
    );

    expect(results.get(1)).toEqual({ status: 'success', count: 2 });
    expect(results.get(2)).toEqual({ status: 'unavailable', count: null });
    expect(ado.getWorkItemCommentCount).toHaveBeenCalledTimes(2);
  });
});
