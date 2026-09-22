jest.mock('../db/drizzle', () => ({ db: {} }));
const createDefinition = jest.fn();
const publishDraft = jest.fn();
const getSkillConfig = jest.fn();
const isFeatureEnabled = jest.fn();
jest.mock('../services/playbookDefinitionService', () => ({
  createDefinition: (...args: unknown[]) => createDefinition(...args),
  publishDraft: (...args: unknown[]) => publishDraft(...args),
}));
jest.mock('../services/projectSettingsService', () => ({
  getSkillConfig: (...args: unknown[]) => getSkillConfig(...args),
}));
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

import { assertGraphWithinGuards } from '../services/playbookGuardService';
import {
  DESIGN_DOC_VALIDATION_PLAYBOOK_KEY,
  buildDesignDocValidationPlaybookGraph,
  publishDesignDocValidationPlaybook,
} from '../services/designDocValidationPlaybookService';
import {
  PlaybookMcpCapabilityError,
  assertCursorAgentsUseReadOnlyMcp,
  resolvePlaybookMcpCapability,
} from '../services/playbookMcpCapabilityService';

const SKILL_PATH = '.cursor/skills/design-doc-validation/SKILL.md';

describe('FEAT-014 design-doc validation Playbook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isFeatureEnabled.mockResolvedValue(true);
    getSkillConfig.mockResolvedValue({
      designDocValidationSkillPath: SKILL_PATH,
      designDocValidationModel: 'auto',
    });
    createDefinition.mockResolvedValue({
      definition: { id: 'definition-1' },
      draft: { updatedAt: '2026-09-22T12:00:00.000Z' },
    });
    publishDraft.mockResolvedValue({
      currentPublishedVersionId: 'version-1',
    });
  });

  it('VT-01 builds the canonical score, ingest, branch, gate-or-notify graph', () => {
    const graph = buildDesignDocValidationPlaybookGraph({
      skillPath: SKILL_PATH,
      model: 'auto',
    });

    expect(DESIGN_DOC_VALIDATION_PLAYBOOK_KEY).toBe('design-doc-validation');
    expect(graph.nodes.map(({ id, stepType }) => ({ id, stepType }))).toEqual([
      { id: 'score', stepType: 'cursor-agent' },
      { id: 'ingest', stepType: 'ingest-artifact' },
      { id: 'route', stepType: 'branch' },
      { id: 'approve-ready', stepType: 'approval-gate' },
      { id: 'notify-revision', stepType: 'notify' },
    ]);
    expect(graph.edges).toEqual([
      { from: 'score', to: 'ingest' },
      { from: 'ingest', to: 'route' },
      { from: 'route', to: 'approve-ready', condition: 'ready' },
      { from: 'route', to: 'notify-revision', condition: 'revision' },
    ]);
    expect(graph.nodes[0].config).toEqual(expect.objectContaining({
      mcpProfile: 'repository-read-only',
      deadlineMs: 5_000 * 720,
      threadId: '${input.validationThreadId}',
    }));
    expect(graph.nodes[2].config).toEqual(expect.objectContaining({
      condition: expect.objectContaining({
        sourceStepId: 'ingest',
        field: 'isReady',
        value: true,
      }),
    }));
    expect(() => assertGraphWithinGuards(graph)).not.toThrow();
  });

  it('VT-02 treats the authoritative repository profile as read-only', () => {
    expect(resolvePlaybookMcpCapability('repository-read-only')).toEqual({
      mode: 'read',
      serverKeys: ['github-repo'],
      evidence: expect.arrayContaining([expect.stringMatching(/read-only/i)]),
    });
  });

  it.each([
    ['write-capable', 'ado-skills'],
    ['unknown', 'not-registered'],
    ['missing', undefined],
  ])('VT-03/04 refuses %s cursor-agent MCP at publish time', (_case, mcpProfile) => {
    const graph = buildDesignDocValidationPlaybookGraph({
      skillPath: SKILL_PATH,
      model: 'auto',
    });
    if (mcpProfile === undefined) delete graph.nodes[0].config!.mcpProfile;
    else graph.nodes[0].config!.mcpProfile = mcpProfile;

    expect(() => assertCursorAgentsUseReadOnlyMcp(graph)).toThrow(
      PlaybookMcpCapabilityError,
    );
  });

  it('enforces the read-only MCP rule on every Playbook, not only the canonical one', () => {
    expect(() => assertCursorAgentsUseReadOnlyMcp({
      nodes: [{
        id: 'other-agent',
        stepType: 'cursor-agent',
        config: {
          skillPath: '.cursor/skills/app-knowledge/SKILL.md',
          prompt: 'Read the repository.',
          mcpProfile: 'ado-skills',
        },
      }],
      edges: [],
    })).toThrow(/other-agent.*ado-skills/is);
  });

  it('seeds and publishes the canonical definition from project validation settings', async () => {
    await expect(publishDesignDocValidationPlaybook({
      project: 'Apex',
      publishedByUserId: 'author-1',
    })).resolves.toEqual(expect.objectContaining({
      definitionId: 'definition-1',
      publishedVersionId: 'version-1',
    }));

    expect(createDefinition).toHaveBeenCalledWith(expect.objectContaining({
      project: 'Apex',
      createdByUserId: 'author-1',
      graph: expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'score',
            config: expect.objectContaining({ skillPath: SKILL_PATH, model: 'auto' }),
          }),
        ]),
      }),
    }));
    expect(publishDraft).toHaveBeenCalledWith({
      project: 'Apex',
      definitionId: 'definition-1',
      publishedByUserId: 'author-1',
      expectedDraftUpdatedAt: '2026-09-22T12:00:00.000Z',
    });
  });

  it('does not seed or publish while playbooks-production-adapters is disabled', async () => {
    isFeatureEnabled.mockResolvedValue(false);

    await expect(publishDesignDocValidationPlaybook({
      project: 'Apex',
      publishedByUserId: 'author-1',
    })).rejects.toThrow(/playbooks-production-adapters.*disabled/i);
    expect(createDefinition).not.toHaveBeenCalled();
    expect(publishDraft).not.toHaveBeenCalled();
  });
});
