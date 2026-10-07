import { assignWorkItemsToRelease } from '../services/releaseManagementService';

describe('assignWorkItemsToRelease', () => {
  const createService = (assignments: Record<number, number[]>) => ({
    findReleaseAssignments: jest.fn().mockResolvedValue(assignments),
    linkWorkItemsToRelease: jest.fn().mockResolvedValue(undefined),
    unlinkWorkItemsFromRelease: jest.fn().mockResolvedValue(undefined),
  });

  it('moves an item from its current release before linking the target release', async () => {
    const service = createService({ 42: [100] });

    const result = await assignWorkItemsToRelease(200, [42], service as any);

    expect(service.unlinkWorkItemsFromRelease).toHaveBeenCalledWith(100, [42]);
    expect(service.linkWorkItemsToRelease).toHaveBeenCalledWith(200, [42]);
    expect(service.unlinkWorkItemsFromRelease.mock.invocationCallOrder[0])
      .toBeLessThan(service.linkWorkItemsToRelease.mock.invocationCallOrder[0]);
    expect(result).toEqual({
      linkedCount: 1,
      movedCount: 1,
      unchangedCount: 0,
      movedFrom: { 42: [100] },
    });
  });

  it('does not add a duplicate link when the item is already assigned to the target', async () => {
    const service = createService({ 42: [200] });

    const result = await assignWorkItemsToRelease(200, [42], service as any);

    expect(service.unlinkWorkItemsFromRelease).not.toHaveBeenCalled();
    expect(service.linkWorkItemsToRelease).not.toHaveBeenCalled();
    expect(result.unchangedCount).toBe(1);
  });

  it('removes duplicate release assignments while preserving the target assignment', async () => {
    const service = createService({ 42: [100, 200, 300] });

    const result = await assignWorkItemsToRelease(200, [42], service as any);

    expect(service.unlinkWorkItemsFromRelease).toHaveBeenNthCalledWith(1, 100, [42]);
    expect(service.unlinkWorkItemsFromRelease).toHaveBeenNthCalledWith(2, 300, [42]);
    expect(service.linkWorkItemsToRelease).not.toHaveBeenCalled();
    expect(result.movedFrom).toEqual({ 42: [100, 300] });
  });

  it('restores the source assignment if linking the target fails', async () => {
    const service = createService({ 42: [100] });
    service.linkWorkItemsToRelease
      .mockRejectedValueOnce(new Error('target link failed'))
      .mockResolvedValueOnce(undefined);

    await expect(assignWorkItemsToRelease(200, [42], service as any))
      .rejects.toThrow('target link failed');

    expect(service.linkWorkItemsToRelease).toHaveBeenNthCalledWith(1, 200, [42]);
    expect(service.linkWorkItemsToRelease).toHaveBeenNthCalledWith(2, 100, [42]);
  });
});
