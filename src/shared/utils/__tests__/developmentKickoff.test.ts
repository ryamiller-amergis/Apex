import {
  buildCloudDevelopmentKickoffSection,
  DEFAULT_DEVELOPMENT_MODEL,
  DEFAULT_DEVELOPMENT_SKILL_PATH,
  resolveDevelopmentSettings,
} from '../developmentKickoff';

describe('resolveDevelopmentSettings', () => {
  it('falls back to dev-orchestrator and composer-2.5 when unset', () => {
    expect(resolveDevelopmentSettings(null)).toEqual({
      skillPath: DEFAULT_DEVELOPMENT_SKILL_PATH,
      skillName: 'dev-orchestrator',
      model: DEFAULT_DEVELOPMENT_MODEL,
      configuredSkillPath: null,
      configuredModel: null,
    });
  });

  it('uses project overrides when configured', () => {
    expect(resolveDevelopmentSettings({
      developmentSkillPath: '.cursor/skills/custom-dev/SKILL.md',
      developmentModel: 'claude-sonnet-4-6',
    })).toEqual({
      skillPath: '.cursor/skills/custom-dev/SKILL.md',
      skillName: 'custom-dev',
      model: 'claude-sonnet-4-6',
      configuredSkillPath: '.cursor/skills/custom-dev/SKILL.md',
      configuredModel: 'claude-sonnet-4-6',
    });
  });
});

describe('buildCloudDevelopmentKickoffSection', () => {
  it('names the configured skill and default model', () => {
    const section = buildCloudDevelopmentKickoffSection(resolveDevelopmentSettings({
      developmentSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      developmentModel: null,
    }));
    expect(section).toContain('This project is configured to use the **dev-orchestrator**');
    expect(section).toContain('`.cursor/skills/dev-orchestrator/SKILL.md`');
    expect(section).toContain('Default model: `composer-2.5`');
  });

  it('names a model override when set', () => {
    const section = buildCloudDevelopmentKickoffSection(resolveDevelopmentSettings({
      developmentSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      developmentModel: 'composer-2.5',
    }));
    expect(section).toContain('Model override: `composer-2.5`');
  });

  it('does not claim configuration when the project has no development skill', () => {
    const section = buildCloudDevelopmentKickoffSection(resolveDevelopmentSettings(null));
    expect(section).toContain('No development skill is configured for this project.');
    expect(section).toContain('Defaulting to **dev-orchestrator**');
    expect(section).not.toContain('This project is configured to use');
  });

  it('tells the agent to fall back when the default skill is absent from the repo', () => {
    const section = buildCloudDevelopmentKickoffSection(resolveDevelopmentSettings(null));
    expect(section).toContain('If it does not, implement from the design artifacts below');
  });
});
