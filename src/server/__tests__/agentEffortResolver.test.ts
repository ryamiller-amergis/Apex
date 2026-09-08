import type { ChatThreadKickoff } from '../../shared/types/chat';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import {
  deriveAgentModule,
  resolveEffort,
} from '../services/agentEffortResolver';

function config(
  overrides: Partial<ProjectSkillConfig> = {}
): ProjectSkillConfig {
  return {
    id: 'settings-1',
    project: 'Apex',
    friendlyName: 'Apex',
    isDefault: true,
    skillRepo: 'org/apex',
    skillBranch: 'main',
    ...overrides,
  };
}

describe('agentEffortResolver', () => {
  it('AC-0 / VT-01: resolves module effort before the project default', () => {
    expect(
      resolveEffort({
        kickoff: {
          project: 'Apex',
          repo: 'org/apex',
          agentModule: 'interview',
        },
        skillConfig: config({ interviewEffort: 'high', defaultEffort: 'low' }),
      })
    ).toBe('high');
  });

  it('AC-1 / BR-002: resolves a server-selected pill or option before module effort', () => {
    expect(
      resolveEffort({
        kickoff: {
          project: 'Apex',
          repo: 'org/apex',
          agentModule: 'interview',
        },
        skillConfig: config({
          interviewEffort: 'low',
          defaultEffort: 'medium',
        }),
        selectedEffort: 'high',
      })
    ).toBe('high');
  });

  it('AC-2 / VT-03: omits effort when no valid tier is configured', () => {
    expect(
      resolveEffort({
        kickoff: {
          project: 'Apex',
          repo: 'org/apex',
          agentModule: 'interview',
        },
        skillConfig: config({ interviewEffort: null, defaultEffort: null }),
      })
    ).toBeUndefined();
  });

  it('AC-3 / VT-02: skips corrupt values without throwing', () => {
    const corrupt = config({
      interviewEffort: 'ultra' as ProjectSkillConfig['interviewEffort'],
      defaultEffort: 'extreme' as ProjectSkillConfig['defaultEffort'],
    });

    expect(
      resolveEffort({
        kickoff: {
          project: 'Apex',
          repo: 'org/apex',
          agentModule: 'interview',
        },
        skillConfig: corrupt,
      })
    ).toBeUndefined();
  });

  it('DoD-1: maps every module identity to its sibling effort setting', () => {
    expect(
      resolveEffort({
        kickoff: { project: 'Apex', repo: 'org/apex', agentModule: 'adr' },
        skillConfig: config({ adrEffort: 'medium' }),
      })
    ).toBe('medium');
    expect(
      resolveEffort({
        kickoff: {
          project: 'Apex',
          repo: 'org/apex',
          agentModule: 'development',
        },
        skillConfig: config({ developmentEffort: 'high' }),
      })
    ).toBe('high');
    expect(
      resolveEffort({
        kickoff: { project: 'Apex', repo: 'org/apex', agentModule: 'standup' },
        skillConfig: config({ standupEffort: 'low' }),
      })
    ).toBe('low');
  });

  it('DoD-0 / VT-04: derives generic-route identities from server config, not request fields', () => {
    const skillConfig = config({
      interviewSkillPath: '.cursor/skills/grill-with-docs/SKILL.md',
      adrInterviewSkillPath: '.cursor/skills/adr-interview/SKILL.md',
      interviewSkillOptions: [
        {
          path: '.cursor/skills/product-interview/SKILL.md',
          friendlyName: 'Product interview',
        },
      ],
    });
    const requestKickoff = {
      project: 'Apex',
      repo: 'org/apex',
      skillPath: '.cursor/skills/grill-with-docs/SKILL.md',
      agentModule: 'technical',
    } as ChatThreadKickoff;

    expect(deriveAgentModule(requestKickoff, skillConfig)).toBe('interview');
    expect(
      deriveAgentModule(
        {
          ...requestKickoff,
          skillPath: '.cursor/skills/adr-interview/SKILL.md',
        },
        skillConfig
      )
    ).toBe('adr');
    expect(
      deriveAgentModule(
        {
          ...requestKickoff,
          skillPath: '.cursor/skills/product-interview/SKILL.md',
        },
        skillConfig
      )
    ).toBe('interview');
    expect(
      deriveAgentModule(
        {
          ...requestKickoff,
          skillPath: '.cursor/skills/app-knowledge/SKILL.md',
        },
        skillConfig
      )
    ).toBeUndefined();
  });

  it('DoD-0: derives Development, Standup, and assistant identities before skill paths', () => {
    const skillConfig = config({
      interviewSkillPath: '.cursor/skills/shared/SKILL.md',
    });
    const kickoff = {
      project: 'Apex',
      repo: 'org/apex',
      skillPath: '.cursor/skills/shared/SKILL.md',
    } satisfies ChatThreadKickoff;

    expect(
      deriveAgentModule({ ...kickoff, mode: 'development' }, skillConfig)
    ).toBe('development');
    expect(
      deriveAgentModule(
        {
          ...kickoff,
          mode: 'standup-participant',
        },
        skillConfig
      )
    ).toBe('standup');
    expect(
      deriveAgentModule(
        {
          ...kickoff,
          assistantType: 'design-doc',
        },
        skillConfig
      )
    ).toBe('designDocAssistant');
    expect(
      deriveAgentModule(
        {
          ...kickoff,
          assistantType: 'adr',
        },
        skillConfig
      )
    ).toBe('adr');
  });
});
