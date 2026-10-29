import {
  PlaybookExecutionCapabilityError,
  parsePlaybookSkillCapabilities,
  resolvePlaybookAgentRunPolicy,
} from '../services/playbookExecutionCapabilityService';

const skill = `---
name: test
description: Test
playbook-capabilities: [repository-read, network-read]
---
# Test
`;

describe('Playbook execution capability policy', () => {
  it('parses the closed capability declaration', () => {
    expect(parsePlaybookSkillCapabilities(skill)).toEqual([
      'repository-read',
      'network-read',
    ]);
    expect(() =>
      parsePlaybookSkillCapabilities(skill.replace('network-read', 'teleport'))
    ).toThrow(PlaybookExecutionCapabilityError);
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

  it('refuses a profile or Skill that is broader or narrower than required', () => {
    expect(() =>
      resolvePlaybookAgentRunPolicy({
        nodeId: 'draft',
        skillPath: 'skill.md',
        skillContent: skill,
        mcpProfile: 'ado-skills',
        enforce: true,
      })
    ).toThrow(/read-only/i);

    expect(() =>
      resolvePlaybookAgentRunPolicy({
        nodeId: 'draft',
        skillPath: 'skill.md',
        skillContent: skill.replace(', network-read', ''),
        mcpProfile: 'repository-read-only',
        enforce: true,
      })
    ).toThrow(/network-read/);
  });
});
