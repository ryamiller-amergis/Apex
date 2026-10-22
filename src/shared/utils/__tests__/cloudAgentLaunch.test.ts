import {
  GUIDED_CLOUD_JOBS,
  buildGuidedCloudAgentPrompt,
  guidedSiteIssueBranchName,
  guidedCloudJobById,
  parseSiteIssueImages,
  recommendGuidedSiteSkill,
  recommendImplementationSkill,
  resolveCloudAgentLaunchSelection,
} from '../cloudAgentLaunch';
import { DEFAULT_DEVELOPMENT_SKILL_PATH } from '../developmentKickoff';

const skills = [
  { name: 'dev-orchestrator', path: '.cursor/skills/dev-orchestrator/SKILL.md', description: 'Implements work' },
  { name: 'fullstack-node-bff', path: '.cursor/skills/fullstack-node-bff/SKILL.md', description: 'Node BFF' },
  { name: 'issue-analysis', path: '.cursor/skills/issue-analysis/SKILL.md', description: 'Issues' },
];

describe('recommendImplementationSkill', () => {
  it('picks the development skill for a product backlog item', () => {
    expect(recommendImplementationSkill({
      workItemType: 'Product Backlog Item',
      skills,
    })).toMatchObject({
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillName: 'dev-orchestrator',
    });
  });

  it('picks the node skill for a technical backlog item when it is installed', () => {
    expect(recommendImplementationSkill({
      workItemType: 'Technical Backlog Item',
      skills,
    }).skillName).toBe('fullstack-node-bff');
  });

  it('falls back to the project development skill when the preferred skill is missing', () => {
    expect(recommendImplementationSkill({
      workItemType: 'Technical Backlog Item',
      skills: [],
      configuredSkillPath: '.cursor/skills/custom-dev/SKILL.md',
    })).toMatchObject({
      skillPath: '.cursor/skills/custom-dev/SKILL.md',
      skillName: 'custom-dev',
    });
  });

  it('uses the default development skill when nothing else is available', () => {
    expect(recommendImplementationSkill({
      workItemType: 'Bug',
      skills: [],
    }).skillPath).toBe(DEFAULT_DEVELOPMENT_SKILL_PATH);
  });
});

describe('resolveCloudAgentLaunchSelection', () => {
  const base = {
    recommendedSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
    recommendedModel: 'composer-2.5',
    allowedSkillPaths: skills.map((skill) => skill.path),
    allowedModelIds: ['composer-2.5', 'claude-sonnet-4-6'],
    priorSkillPath: '.cursor/skills/fullstack-node-bff/SKILL.md',
    priorModel: 'claude-sonnet-4-6',
  };

  it('resume keeps the original skill and model and ignores a requested change', () => {
    expect(resolveCloudAgentLaunchSelection({
      ...base,
      intent: 'resume',
      requestedSkillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      requestedModel: 'composer-2.5',
    })).toEqual({
      ok: true,
      skillPath: '.cursor/skills/fullstack-node-bff/SKILL.md',
      model: 'claude-sonnet-4-6',
      keptPriorSettings: true,
    });
  });

  it('resume fails when the original run did not save a skill and model', () => {
    const result = resolveCloudAgentLaunchSelection({
      ...base,
      intent: 'resume',
      priorSkillPath: null,
      priorModel: null,
    });
    expect(result.ok).toBe(false);
  });

  it('retry uses the requested skill and model', () => {
    expect(resolveCloudAgentLaunchSelection({
      ...base,
      intent: 'retry',
      requestedSkillPath: '.cursor/skills/issue-analysis/SKILL.md',
      requestedModel: 'composer-2.5',
    })).toMatchObject({
      ok: true,
      skillPath: '.cursor/skills/issue-analysis/SKILL.md',
      model: 'composer-2.5',
      keptPriorSettings: false,
    });
  });

  it('rejects a skill that is not installed and was not the recommendation', () => {
    const result = resolveCloudAgentLaunchSelection({
      ...base,
      intent: 'start',
      requestedSkillPath: '.cursor/skills/not-a-skill/SKILL.md',
    });
    expect(result).toEqual({ ok: false, error: 'Choose a skill from this project.' });
  });
});

describe('guided cloud jobs', () => {
  it('uses the skill the project has installed when dev-orchestrator is absent', () => {
    expect(recommendGuidedSiteSkill({
      skills: [{ name: 'apex-implement-feature', path: '.cursor/skills/apex-implement-feature/SKILL.md' }],
      configuredSkillPath: null,
    })).toEqual({
      skillPath: '.cursor/skills/apex-implement-feature/SKILL.md',
      skillName: 'apex-implement-feature',
    });
  });

  it('lists the site-issue report', () => {
    expect(GUIDED_CLOUD_JOBS.map((job) => job.id)).toEqual(['site-issue']);
    expect(guidedCloudJobById('site-issue')?.skillName).toBe('dev-orchestrator');
  });

  it('names a branch from the report without a work item id', () => {
    expect(guidedSiteIssueBranchName('abc12345-0000-0000-0000-000000000000', 'The login page times out.')).toBe(
      'feature/apex-site-abc123-the-login-page-times-out',
    );
  });

  it('tells the agent to investigate and open a pull request', () => {
    const prompt = buildGuidedCloudAgentPrompt({
      title: "There's an issue on the site",
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillName: 'dev-orchestrator',
      task: 'The login page times out.',
      branchName: 'feature/apex-site-abc123-the-login-page-times-out',
    });
    expect(prompt.startsWith('/dev-orchestrator')).toBe(true);
    expect(prompt).toContain('Open a pull request titled `[APEX] apex-site-abc123-the-login-page-times-out`');
    expect(prompt).toContain('The login page times out.');
    expect(prompt).toContain('This report has no work item.');
    expect(prompt).not.toContain('screenshot');
  });

  it('tells the agent to use attached screenshots', () => {
    const prompt = buildGuidedCloudAgentPrompt({
      title: "There's an issue on the site",
      skillPath: '.cursor/skills/dev-orchestrator/SKILL.md',
      skillName: 'dev-orchestrator',
      task: 'The login page times out.',
      branchName: 'feature/apex-site-abc123-the-login-page-times-out',
      imageCount: 2,
    });
    expect(prompt).toContain('This message includes 2 screenshots.');
  });

  it('accepts up to three small screenshots', () => {
    const image = { name: 'home.png', mimeType: 'image/png' as const, data: 'YQ==' };
    expect(parseSiteIssueImages([image, image, image])).toEqual({
      ok: true,
      images: [image, image, image],
    });
    expect(parseSiteIssueImages([image, image, image, image])).toEqual({
      ok: false,
      error: 'Add up to 3 screenshots.',
    });
    expect(parseSiteIssueImages([{ ...image, mimeType: 'image/gif' }])).toEqual({
      ok: false,
      error: 'Screenshots must be PNG, JPEG, or WebP.',
    });
  });
});
