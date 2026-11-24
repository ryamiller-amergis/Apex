import {
  PlaybookExecutionCapabilityError,
  loadPlaybookSkillCompanions,
  parsePlaybookSkillCapabilities,
  resolvePlaybookAgentRunPolicy,
} from '../services/playbookExecutionCapabilityService';
import { parsePlaybookSkillFrontmatter } from '../services/playbookSkillFrontmatter';
import { bundleHashV1 } from '../services/playbookSkillBundle';

const skill = `---
name: test
description: Test
playbook-capabilities: [repository-read, network-read]
---
# Test
`;

describe('Playbook execution capability policy', () => {
  it('loads the markdown files that sit beside a Skill', async () => {
    const companions = await loadPlaybookSkillCompanions(
      'playbook-skills/maxview-incident-investigation/SKILL.md',
    );
    expect(companions.map((file) => file.path).sort()).toEqual([
      'INVESTIGATION_GUIDE.md',
      'RESOURCE_CATALOG.md',
    ]);
  });

  it('parses the closed capability declaration', () => {
    expect(parsePlaybookSkillCapabilities(skill)).toEqual([
      'repository-read',
      'network-read',
    ]);
    expect(parsePlaybookSkillCapabilities('---\nname: x\n---\n')).toBeNull();
    expect(() =>
      parsePlaybookSkillCapabilities(skill.replace('network-read', 'teleport'))
    ).toThrow(PlaybookExecutionCapabilityError);
  });

  it('runs a Skill that does not declare playbook-capabilities', () => {
    const policy = resolvePlaybookAgentRunPolicy({
      nodeId: 'draft',
      skillPath: 'skill.md',
      skillContent: '---\nname: x\ndescription: Y\n---\n',
      mcpProfile: 'repository-read-only',
      enforce: true,
    });

    expect(policy.capabilities).toEqual(['repository-read', 'network-read']);
  });

  it('freezes a read-only policy without credentials', () => {
    const policy = resolvePlaybookAgentRunPolicy({
      nodeId: 'draft',
      skillPath: '.cursor/skills/test/SKILL.md',
      skillContent: skill,
      mcpProfile: 'repository-read-only',
      repository: 'Apex',
      provider: 'github',
      groundedSha: 'abc123',
      enforce: true,
      resolvedAt: '2026-10-19T00:00:00.000Z',
    });

    expect(policy).toMatchObject({
      schemaVersion: 1,
      executionProfile: 'repository-read-only',
      capabilities: ['repository-read', 'network-read'],
      localAgent: {
        cwdMode: 'scratch',
        allowBuiltinWrites: false,
        customTools: 'native-read-only',
      },
      enforcement: 'enforce',
    });
    expect(JSON.stringify(policy)).not.toMatch(/token|secret|credential/i);
  });

  it('includes azure-cli when the Skill declares it', () => {
    const policy = resolvePlaybookAgentRunPolicy({
      nodeId: 'investigate',
      skillPath: 'skill.md',
      skillContent: skill.replace(
        'playbook-capabilities: [repository-read, network-read]',
        'playbook-capabilities: [repository-read, network-read, azure-cli]',
      ),
      mcpProfile: 'repository-read-only',
      enforce: true,
    });

    expect(policy.capabilities).toEqual(['repository-read', 'network-read', 'azure-cli']);
  });

  it('refuses a profile that is not read-only', () => {
    expect(() =>
      resolvePlaybookAgentRunPolicy({
        nodeId: 'draft',
        skillPath: 'skill.md',
        skillContent: skill,
        mcpProfile: 'ado-skills',
        enforce: true,
      })
    ).toThrow(/read-only/i);
  });

  it('still runs a Skill that declares only some capabilities', () => {
    const policy = resolvePlaybookAgentRunPolicy({
      nodeId: 'draft',
      skillPath: 'skill.md',
      skillContent: skill.replace(', network-read', ''),
      mcpProfile: 'repository-read-only',
      enforce: true,
    });

    expect(policy.capabilities).toEqual(['repository-read', 'network-read']);
  });

  it('pins a project skill with a bundle hash and leaves a foundation skill without one', () => {
    const companions = [{ path: 'GUIDE.md', content: 'Read this.\n', classification: 'instruction' as const }];
    const policy = resolvePlaybookAgentRunPolicy({
      nodeId: 'draft',
      skillPath: 'project-skills/00000000-0000-4000-8000-000000000001/SKILL.md',
      skillContent: skill,
      mcpProfile: 'repository-read-only',
      enforce: true,
      bundle: { skillVersionId: '00000000-0000-4000-8000-000000000001', companions },
    });
    expect(policy.bundleSha256).toBe(bundleHashV1({
      skillVersionId: '00000000-0000-4000-8000-000000000001',
      skillContent: skill,
      companions,
    }));
    expect(parsePlaybookSkillFrontmatter('---\nname: local\ndescription: Mine\nmetadata:\n  apex:\n    output-kind: report@1\n---\n').outputKind).toBe('report@1');
  });
});
