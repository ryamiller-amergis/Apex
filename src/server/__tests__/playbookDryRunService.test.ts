jest.mock('../services/playbookDefinitionService', () => ({
  getDefinitionDetail: jest.fn(),
}));

jest.mock('../services/rbacService', () => ({
  getUserPermissions: jest.fn(),
}));

import { getDefinitionDetail } from '../services/playbookDefinitionService';
import { getUserPermissions } from '../services/rbacService';
import { dryRunPlaybookDraft } from '../services/playbookDryRunService';

const DEMO_SKILL_PATH = '.cursor/skills/app-knowledge/SKILL.md';

const mockDetail = getDefinitionDetail as jest.MockedFunction<typeof getDefinitionDetail>;
const mockPermissions = getUserPermissions as jest.MockedFunction<typeof getUserPermissions>;

describe('dryRunPlaybookDraft', () => {
  beforeEach(() => {
    mockPermissions.mockResolvedValue(new Set(['playbooks:view', 'playbooks:author']));
  });

  it('passes a minimal cursor-agent → notify graph', async () => {
    mockDetail.mockResolvedValue({
      definition: {
        id: 'def-1',
        project: 'Apex',
        name: 'Test',
        description: null,
        templateKey: null,
        templateVersion: null,
        createdBy: 'u1',
        createdAt: '',
        updatedAt: '',
      },
      draft: {
        id: 'draft-1',
        definitionId: 'def-1',
        nextVersionNumber: 1,
        updatedAt: '',
        graph: {
          nodes: [
            {
              id: 'a',
              stepType: 'cursor-agent',
              config: {
                skillPath: DEMO_SKILL_PATH,
                prompt: 'Do the work.',
                mcpProfile: 'repository-read-only',
              },
            },
            { id: 'b', stepType: 'notify', config: { title: 'Done' } },
          ],
          edges: [{ from: 'a', to: 'b' }],
        },
      },
      versions: [],
      currentPublishedVersionId: null,
    });

    const result = await dryRunPlaybookDraft({
      project: 'Apex',
      definitionId: 'def-1',
      stubs: {},
      userId: 'u1',
    });

    expect(result.verdict).toBe('passed');
    expect(result.issues).toHaveLength(0);
  });

  it('reports graph issues for unknown step types', async () => {
    mockDetail.mockResolvedValue({
      definition: {
        id: 'def-1',
        project: 'Apex',
        name: 'Test',
        description: null,
        templateKey: null,
        templateVersion: null,
        createdBy: 'u1',
        createdAt: '',
        updatedAt: '',
      },
      draft: {
        id: 'draft-1',
        definitionId: 'def-1',
        nextVersionNumber: 1,
        updatedAt: '',
        graph: {
          nodes: [{ id: 'x', stepType: 'not-real' }],
          edges: [],
        },
      },
      versions: [],
      currentPublishedVersionId: null,
    });

    const result = await dryRunPlaybookDraft({
      project: 'Apex',
      definitionId: 'def-1',
      stubs: {},
      userId: 'u1',
    });

    expect(result.verdict).toBe('failed');
    expect(result.issues.some((issue) => issue.kind === 'graph')).toBe(true);
  });
});
