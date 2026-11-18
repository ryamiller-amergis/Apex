import {
  applyCloudAgentKickoff,
  kickoffInProgressIds,
  type CloudAgentKickoffClient,
} from '../services/cloudAgentKickoff';

function client(overrides: Partial<CloudAgentKickoffClient> = {}): CloudAgentKickoffClient {
  return {
    getFeatureChildren: jest.fn().mockResolvedValue([]),
    setWorkItemState: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('cloud agent kickoff work-item updates', () => {
  it('moves a not-yet-started backlog item to In Progress and does not set a due date', async () => {
    const ado = client();

    await applyCloudAgentKickoff({
      project: 'MaxView',
      workItemId: 42,
      workItemType: 'Product Backlog Item',
      state: 'Committed',
    }, ado);

    expect(ado.setWorkItemState).toHaveBeenCalledWith(42, 'In Progress');
    expect(ado.setWorkItemState).not.toHaveBeenCalledWith(42, 'In Pull Request');
  });

  it('leaves an already active bug alone', async () => {
    const ado = client();

    await applyCloudAgentKickoff({
      project: 'MaxView',
      workItemId: 42,
      workItemType: 'Bug',
      state: 'Active',
    }, ado);

    expect(ado.setWorkItemState).not.toHaveBeenCalled();
  });

  it('moves a Feature and its not-yet-started children to In Progress, never In Pull Request', async () => {
    const ado = client({
      getFeatureChildren: jest.fn().mockResolvedValue([
        { id: 201, workItemType: 'Product Backlog Item', state: 'New' },
        { id: 202, workItemType: 'Technical Backlog Item', state: 'In Progress' },
        { id: 203, workItemType: 'Bug', state: 'Committed' },
        { id: 204, workItemType: 'Product Backlog Item', state: 'Done' },
      ]),
    });

    await applyCloudAgentKickoff({
      project: 'MaxView',
      workItemId: 100,
      workItemType: 'Feature',
      state: 'Committed',
    }, ado);

    expect(ado.setWorkItemState).toHaveBeenCalledWith(100, 'In Progress');
    expect(ado.setWorkItemState).toHaveBeenCalledWith(201, 'In Progress');
    expect(ado.setWorkItemState).toHaveBeenCalledWith(203, 'In Progress');
    expect(ado.setWorkItemState).not.toHaveBeenCalledWith(202, 'In Progress');
    expect(ado.setWorkItemState).not.toHaveBeenCalledWith(204, 'In Progress');
    const states = (ado.setWorkItemState as jest.Mock).mock.calls.map((call) => call[1]);
    expect(states).not.toContain('In Pull Request');
  });

  it('tags the started work item and children that move to In Progress', async () => {
    const ado = client({
      addTag: jest.fn().mockResolvedValue(undefined),
      getFeatureChildren: jest.fn().mockResolvedValue([
        { id: 201, workItemType: 'Product Backlog Item', state: 'New' },
        { id: 202, workItemType: 'Product Backlog Item', state: 'Done' },
      ]),
    });

    await applyCloudAgentKickoff({
      project: 'MaxView',
      workItemId: 100,
      workItemType: 'Feature',
      state: 'In Progress',
      tagAiCode: true,
    }, ado);

    expect(ado.addTag).toHaveBeenCalledWith(100, 'ai-code');
    expect(ado.addTag).toHaveBeenCalledWith(201, 'ai-code');
    expect(ado.addTag).not.toHaveBeenCalledWith(202, 'ai-code');
  });

  it('moves only not-yet-started feature children when the feature is already in progress', () => {
    expect(kickoffInProgressIds({
      workItemId: 100,
      workItemType: 'Feature',
      state: 'In Progress',
      children: [{ id: 1, workItemType: 'Product Backlog Item', state: 'Approved' }],
    })).toEqual([1]);
  });
});
