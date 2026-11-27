const mockRows = jest.fn<Promise<{ integration: string; operation: string }[]>, []>();
jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => mockRows() }) }),
    transaction: jest.fn(),
  },
}));

import {
  assertConnectorWriteAllowed,
  assertConnectorWritesAllowedForGraph,
  listAllowedConnectorWrites,
  PlaybookConnectorWriteError,
  setAllowedConnectorWrites,
} from '../services/playbookConnectorWriteAllowListService';
import { findUngatedLeavesApexSteps } from '../services/playbookGuardService';
import { playbookConnectorWriteOptions } from '../../shared/types/playbookConnectors';
import type { PlaybookGraph } from '../../shared/types/playbook';

beforeEach(() => mockRows.mockReset());

function connectorGraph(operation: string, integration = 'azure-devops'): PlaybookGraph {
  return {
    nodes: [
      { id: 'gate', stepType: 'approval-gate', config: {} },
      { id: 'act', stepType: 'connector', config: { integration, operation } },
    ],
    edges: [{ from: 'gate', to: 'act' }],
  };
}

describe('approval gate for connector writes in the real catalog', () => {
  it('asks for a gate before a write and not before a read', () => {
    const ungated = (operation: string): PlaybookGraph => ({
      nodes: [{ id: 'act', stepType: 'connector', config: { integration: 'azure-devops', operation } }],
      edges: [],
    });
    expect(findUngatedLeavesApexSteps(ungated('create-work-item'))).toEqual(['act']);
    expect(findUngatedLeavesApexSteps(ungated('rest-write'))).toEqual(['act']);
    expect(findUngatedLeavesApexSteps(ungated('list-pull-requests'))).toEqual([]);
    expect(findUngatedLeavesApexSteps(connectorGraph('create-work-item'))).toEqual([]);
  });
});

describe('connector write catalog', () => {
  it('lists each write operation once, with the integration it belongs to', () => {
    const options = playbookConnectorWriteOptions();
    const ids = options.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining([
      'azure-devops/create-work-item',
      'azure-devops/update-work-item',
      'azure-devops/post-comment',
      'azure-devops/create-pull-request',
      'azure-devops/rest-write',
    ]));
    expect(ids).not.toContain('azure-devops/list-branches');
  });
});

describe('listAllowedConnectorWrites', () => {
  it('returns the ids a project allows and drops ones the catalog no longer lists', async () => {
    mockRows.mockResolvedValue([
      { integration: 'azure-devops', operation: 'create-work-item' },
      { integration: 'azure-devops', operation: 'retired-operation' },
      { integration: 'azure-devops', operation: 'list-branches' },
    ]);
    await expect(listAllowedConnectorWrites('MaxView')).resolves.toEqual(['azure-devops/create-work-item']);
  });
});

describe('setAllowedConnectorWrites', () => {
  it('refuses an id that is not a write operation, so a read cannot be stored as one', async () => {
    await expect(setAllowedConnectorWrites({
      project: 'MaxView',
      operations: ['azure-devops/list-branches'],
      actorUserId: 'u1',
    })).rejects.toBeInstanceOf(PlaybookConnectorWriteError);
  });

  it('refuses an operation Apex does not offer', async () => {
    await expect(setAllowedConnectorWrites({
      project: 'MaxView',
      operations: ['github/delete-repository'],
      actorUserId: 'u1',
    })).rejects.toThrow(/not a connector write operation/);
  });
});

describe('assertConnectorWriteAllowed', () => {
  it('passes a read without reading the allow-list', async () => {
    await expect(assertConnectorWriteAllowed('MaxView', 'azure-devops', 'list-branches')).resolves.toBeUndefined();
    expect(mockRows).not.toHaveBeenCalled();
  });

  it('passes a write the project allows', async () => {
    mockRows.mockResolvedValue([{ integration: 'azure-devops', operation: 'post-comment' }]);
    await expect(assertConnectorWriteAllowed('MaxView', 'azure-devops', 'post-comment')).resolves.toBeUndefined();
  });

  it('refuses a write the project has not allowed, naming the project and the action', async () => {
    mockRows.mockResolvedValue([]);
    await expect(assertConnectorWriteAllowed('MaxView', 'azure-devops', 'post-comment', 'step-1')).rejects.toThrow(
      /MaxView has not allowed "Azure DevOps · Post a comment"/,
    );
  });

  it('names the step on the error so the canvas can select it', async () => {
    mockRows.mockResolvedValue([]);
    await expect(assertConnectorWriteAllowed('MaxView', 'azure-devops', 'post-comment', 'step-1'))
      .rejects.toMatchObject({ nodeId: 'step-1' });
  });
});

describe('assertConnectorWritesAllowedForGraph', () => {
  it('does not read the allow-list when the graph has no connector write', async () => {
    await expect(assertConnectorWritesAllowedForGraph('MaxView', connectorGraph('list-branches')))
      .resolves.toBeUndefined();
    expect(mockRows).not.toHaveBeenCalled();
  });

  it('accepts a graph whose write the project allows', async () => {
    mockRows.mockResolvedValue([{ integration: 'azure-devops', operation: 'create-pull-request' }]);
    await expect(assertConnectorWritesAllowedForGraph('MaxView', connectorGraph('create-pull-request')))
      .resolves.toBeUndefined();
  });

  it('refuses a graph whose write the project has not allowed, and names the step', async () => {
    mockRows.mockResolvedValue([{ integration: 'azure-devops', operation: 'post-comment' }]);
    await expect(assertConnectorWritesAllowedForGraph('MaxView', connectorGraph('create-pull-request')))
      .rejects.toMatchObject({
        nodeId: 'act',
        message: expect.stringContaining('Step "act" uses "Azure DevOps · Create a pull request"'),
      });
  });

  it('ignores a step type that is not a connector, whatever its config says', async () => {
    const graph: PlaybookGraph = {
      nodes: [{ id: 'n', stepType: 'notify', config: { integration: 'azure-devops', operation: 'rest-write' } }],
      edges: [],
    };
    await expect(assertConnectorWritesAllowedForGraph('MaxView', graph)).resolves.toBeUndefined();
  });
});
