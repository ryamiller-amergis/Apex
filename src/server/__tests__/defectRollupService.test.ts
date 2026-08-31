import { DefectRollupService } from '../services/defectRollupService';

describe('DefectRollupService', () => {
  test('TBI-004 PBI-004 AC-0 VT-13 counts only open hierarchy-forward child Bugs', async () => {
    const queryLinks = jest.fn().mockResolvedValue([
      { sourceId: 10, targetId: 101 },
      { sourceId: 10, targetId: 102 },
      { sourceId: 20, targetId: 103 },
    ]);
    const getItems = jest.fn().mockResolvedValue([
      { id: 10, fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'Older', 'System.ChangedDate': '2026-08-01T00:00:00Z' } },
      { id: 20, fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'Stale', 'System.ChangedDate': '2026-07-01T00:00:00Z' } },
      { id: 101, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active' } },
      { id: 102, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Resolved' } },
      { id: 103, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'New' } },
    ]);
    const service = new DefectRollupService({ queryLinks, getItems });

    await expect(service.getRollup({ project: 'Apex' })).resolves.toEqual({
      projectOpenDefectCount: 2,
      pbiRows: [
        { pbiId: 20, title: 'Stale', changedAt: '2026-07-01T00:00:00Z', openDefectCount: 1 },
        { pbiId: 10, title: 'Older', changedAt: '2026-08-01T00:00:00Z', openDefectCount: 1 },
      ],
    });
    expect(queryLinks.mock.calls[0][0]).toContain("System.LinkTypes.Hierarchy-Forward");
  });

  test('TBI-004 VT-15 excludes closed states and non-child Related/Duplicate links', async () => {
    const service = new DefectRollupService({
      queryLinks: jest.fn().mockResolvedValue([{ sourceId: 10, targetId: 101 }]),
      getItems: jest.fn().mockResolvedValue([
        { id: 10, fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': 'PBI', 'System.ChangedDate': '2026-08-01T00:00:00Z' } },
        { id: 101, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Removed' } },
        { id: 999, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active' } },
      ]),
    });

    await expect(service.getRollup({ project: 'Apex' })).resolves.toEqual({
      projectOpenDefectCount: 0,
      pbiRows: [{ pbiId: 10, title: 'PBI', changedAt: '2026-08-01T00:00:00Z', openDefectCount: 0 }],
    });
  });

  test('TBI-004 PBI-004 AC-2 VT-23 returns explicit empty and total may exceed displayed 20-row sum', async () => {
    const links = Array.from({ length: 21 }, (_, i) => ({ sourceId: i + 1, targetId: 100 + i }));
    const items = links.flatMap(({ sourceId, targetId }) => [
      { id: sourceId, fields: { 'System.WorkItemType': 'Product Backlog Item', 'System.Title': `PBI ${sourceId}`, 'System.ChangedDate': `2026-08-${String(sourceId).padStart(2, '0')}T00:00:00Z` } },
      { id: targetId, fields: { 'System.WorkItemType': 'Bug', 'System.State': 'Active' } },
    ]);
    const service = new DefectRollupService({
      queryLinks: jest.fn().mockResolvedValue(links),
      getItems: jest.fn().mockResolvedValue(items),
    });
    const result = await service.getRollup({ project: 'Apex' });
    expect(result.projectOpenDefectCount).toBe(21);
    expect(result.pbiRows).toHaveLength(20);
    expect(result.pbiRows.reduce((sum, row) => sum + row.openDefectCount, 0)).toBe(20);

    const empty = new DefectRollupService({
      queryLinks: jest.fn().mockResolvedValue([]),
      getItems: jest.fn(),
    });
    await expect(empty.getRollup({ project: 'Apex' })).resolves.toEqual({
      projectOpenDefectCount: 0,
      pbiRows: [],
    });
  });
});
