import { createPendingWorkService } from '../services/pendingWorkService';

describe('FEAT-016 pending-work source registry', () => {
  it('sorts by deadline, caps at five, and preserves the accurate source total', async () => {
    const service = createPendingWorkService([{
      key: 'playbook-gates',
      listPending: jest.fn().mockResolvedValue({
        total: 7,
        items: Array.from({ length: 7 }, (_, index) => ({
          id: `gate-${index}`,
          source: 'playbook-gates',
          title: `Gate ${index}`,
          deadline: new Date(Date.UTC(2026, 8, 22, 12, 7 - index)).toISOString(),
          href: `/playbooks?filter=assigned-to-me&run=${index}`,
          urgencyText: `Due ${index}`,
        })),
      }),
    }]);

    const result = await service.listPending({ project: 'Apex', userId: 'user-1' });
    expect(result.items).toHaveLength(5);
    expect(result.total).toBe(7);
    expect(result.items.map((item) => item.id)).toEqual([
      'gate-6', 'gate-5', 'gate-4', 'gate-3', 'gate-2',
    ]);
    expect(result.soonestDeadline).toBe(result.items[0].deadline);
    expect(result.viewAllHref).toBe('/playbooks?filter=assigned-to-me');
  });

  it('allows a later source without changing aggregation', async () => {
    const empty = (key: string) => ({
      key,
      listPending: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    });
    const service = createPendingWorkService([empty('playbook-gates'), empty('later-source')]);
    await expect(service.listPending({ project: 'Apex', userId: 'u' })).resolves.toMatchObject({
      items: [],
      total: 0,
    });
  });

  it('refuses duplicate source keys', () => {
    const source = {
      key: 'playbook-gates',
      listPending: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    };
    expect(() => createPendingWorkService([source, source])).toThrow(/unique/);
  });
});
