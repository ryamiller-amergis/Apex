import { parsePlaybookSkillFrontmatter } from '../services/playbookSkillFrontmatter';
import { resolvePlaybookAgentRunPolicy } from '../services/playbookExecutionCapabilityService';

const mockRows = jest.fn<Promise<{ tool: string }[]>, []>();
jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => mockRows() }) }),
    transaction: jest.fn(),
  },
}));
jest.mock('../services/playbookProjectSkillService', () => ({
  loadStoredProjectSkill: jest.fn(),
  projectSkillVersionIdFromPath: jest.fn(),
}));

import {
  assertSkillToolsAllowed,
  listAllowedPlaybookTools,
  PlaybookToolAllowListError,
  setAllowedPlaybookTools,
} from '../services/playbookToolAllowListService';

function skill(extra: string): string {
  return `---\nname: a\ndescription: "d"\n${extra}metadata:\n  apex:\n    skill-type: autonomous\n---\nBody`;
}

beforeEach(() => mockRows.mockReset());

describe('skill frontmatter capabilities', () => {
  it('lists the tools named in playbook-capabilities', () => {
    expect(parsePlaybookSkillFrontmatter(skill('playbook-capabilities: [azure-cli, aws-cli]\n')).capabilities)
      .toEqual(['azure-cli', 'aws-cli']);
    expect(parsePlaybookSkillFrontmatter(skill('')).capabilities).toEqual([]);
  });

  it('rejects a capabilities line that is not a list', () => {
    expect(() => parsePlaybookSkillFrontmatter(skill('playbook-capabilities: azure-cli\n'))).toThrow(
      /must be a list/,
    );
  });
});

describe('project tool allow-list', () => {
  it('lets a skill with no tools through without reading the allow-list', async () => {
    await expect(assertSkillToolsAllowed('Apex', [])).resolves.toBeUndefined();
    expect(mockRows).not.toHaveBeenCalled();
  });

  it('lets a skill name a tool its project allows', async () => {
    mockRows.mockResolvedValue([{ tool: 'azure-cli' }]);
    await expect(assertSkillToolsAllowed('Apex', ['azure-cli'])).resolves.toBeUndefined();
  });

  it('refuses a tool the project has not allowed, naming the tool and project', async () => {
    mockRows.mockResolvedValue([]);
    await expect(assertSkillToolsAllowed('Apex', ['azure-cli'])).rejects.toThrow(
      /Apex has not enabled Azure CLI/,
    );
  });

  it('refuses a tool Apex does not offer, even when a row exists for it', async () => {
    mockRows.mockResolvedValue([{ tool: 'aws-cli' }]);
    await expect(assertSkillToolsAllowed('Apex', ['aws-cli'])).rejects.toThrow(/does not offer/);
  });

  it('drops stored tools the catalog no longer lists', async () => {
    mockRows.mockResolvedValue([{ tool: 'azure-cli' }, { tool: 'retired-tool' }]);
    await expect(listAllowedPlaybookTools('Apex')).resolves.toEqual(['azure-cli']);
  });

  it('refuses to allow a tool that is not in the catalog', async () => {
    await expect(
      setAllowedPlaybookTools({ project: 'Apex', tools: ['rm-rf'], actorUserId: 'u1' }),
    ).rejects.toBeInstanceOf(PlaybookToolAllowListError);
  });
});

describe('run policy', () => {
  const base = {
    nodeId: 'n1',
    mcpProfile: undefined,
    skillPath: 'a/SKILL.md',
    skillHash: 'h',
    provider: 'ado' as const,
  };

  it('grants a catalog tool only when the skill names it', () => {
    const withTool = resolvePlaybookAgentRunPolicy({ ...base, skillContent: skill('playbook-capabilities: [azure-cli]\n') } as never);
    const without = resolvePlaybookAgentRunPolicy({ ...base, skillContent: skill('') } as never);
    expect(withTool.capabilities).toContain('azure-cli');
    expect(without.capabilities).not.toContain('azure-cli');
  });

  it('never grants a capability that is not a catalog tool', () => {
    const policy = resolvePlaybookAgentRunPolicy({
      ...base,
      skillContent: skill('playbook-capabilities: [external-write, deployment]\n'),
    } as never);
    expect(policy.capabilities).toEqual(['repository-read', 'network-read']);
  });
});
