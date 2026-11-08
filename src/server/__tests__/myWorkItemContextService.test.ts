import { buildMyWorkItemContext } from '../services/myWorkItemContextService';

function client(overrides: Record<string, unknown> = {}) {
  return {
    getWorkItemsByIds: jest.fn().mockResolvedValue([]),
    getFeatureChildren: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('buildMyWorkItemContext', () => {
  it('returns null when the work item is missing', async () => {
    const ado = client();
    await expect(buildMyWorkItemContext(ado, 42)).resolves.toBeNull();
    expect(ado.getFeatureChildren).not.toHaveBeenCalled();
  });

  it('strips Azure DevOps HTML and lists a Feature’s children with their states', async () => {
    const ado = client({
      getWorkItemsByIds: jest.fn().mockResolvedValue([{
        id: 42,
        title: 'Shift scheduler',
        workItemType: 'Feature',
        state: 'In Progress',
        description: '<div>Build the <b>scheduler</b></div>',
        acceptanceCriteria: '<ul><li>Nurses can pick a shift</li></ul>',
        reproSteps: '',
        design: '<p>Use the existing calendar.</p>',
      }]),
      getFeatureChildren: jest.fn().mockResolvedValue([
        { id: 201, title: 'Pick a shift', workItemType: 'Product Backlog Item', state: 'New' },
        { id: 202, title: 'Save the pick', workItemType: 'Technical Backlog Item', state: 'In Pull Request' },
      ]),
    });

    await expect(buildMyWorkItemContext(ado, 42)).resolves.toEqual({
      id: 42,
      title: 'Shift scheduler',
      workItemType: 'Feature',
      state: 'In Progress',
      description: 'Build the scheduler',
      acceptanceCriteria: '• Nurses can pick a shift',
      reproSteps: '',
      design: 'Use the existing calendar.',
      children: [
        { id: 201, title: 'Pick a shift', workItemType: 'Product Backlog Item', state: 'New' },
        { id: 202, title: 'Save the pick', workItemType: 'Technical Backlog Item', state: 'In Pull Request' },
      ],
    });
    expect(ado.getFeatureChildren).toHaveBeenCalledWith(42);
  });

  it('does not look up children for a leaf work item', async () => {
    const ado = client({
      getWorkItemsByIds: jest.fn().mockResolvedValue([{
        id: 99,
        title: 'Fix crash',
        workItemType: 'Bug',
        state: 'New',
        description: '',
        acceptanceCriteria: '',
        reproSteps: '<p>Open the calendar</p>',
        design: '',
      }]),
    });

    const result = await buildMyWorkItemContext(ado, 99);
    expect(result?.children).toEqual([]);
    expect(result?.reproSteps).toBe('Open the calendar');
    expect(ado.getFeatureChildren).not.toHaveBeenCalled();
  });
});
