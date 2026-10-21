import { skillNameFromPath } from '../skillPaths';
import {
  DEFAULT_DEVELOPMENT_MODEL,
  DEFAULT_DEVELOPMENT_SKILL_PATH,
} from './developmentKickoff';

export const AI_CODE_TAG = 'ai-code';

export type CloudAgentLaunchIntent = 'start' | 'resume' | 'retry';
export type CloudAgentDelivery = 'implementation' | 'guided';

export interface CloudAgentSkillChoice {
  name: string;
  path: string;
  description: string;
}

export interface GuidedCloudJob {
  id: string;
  title: string;
  description: string;
  skillName: string;
}

/**
 * One Home job for someone who is not writing code. They describe a site
 * problem. The development skill investigates it and opens a pull request.
 */
export const GUIDED_CLOUD_JOBS: readonly GuidedCloudJob[] = [
  {
    id: 'site-issue',
    title: "There's an issue on the site",
    description: 'Explain what you saw. The agent looks into it and opens a pull request for a developer to review.',
    skillName: 'dev-orchestrator',
  },
];

/** Branch for a site report that has no Azure DevOps work item. */
export function guidedSiteIssueBranchName(sessionId: string, task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  const suffix = sessionId.replace(/-/g, '').slice(0, 6) || 'issue';
  return slug ? `feature/apex-site-${suffix}-${slug}` : `feature/apex-site-${suffix}`;
}

/** First installed skill wins. Later names are fallbacks. */
const IMPLEMENTATION_SKILL_PREFERENCES: Record<string, readonly string[]> = {
  'Product Backlog Item': ['dev-orchestrator'],
  PBI: ['dev-orchestrator'],
  'Technical Backlog Item': ['fullstack-node-bff', 'dev-orchestrator'],
  TBI: ['fullstack-node-bff', 'dev-orchestrator'],
  Bug: ['dev-orchestrator'],
  Feature: ['dev-orchestrator'],
};

export function guidedCloudJobById(id: string): GuidedCloudJob | null {
  return GUIDED_CLOUD_JOBS.find((job) => job.id === id) ?? null;
}

export function installedSkillPath(
  skills: ReadonlyArray<Pick<CloudAgentSkillChoice, 'name' | 'path'>>,
  skillName: string,
): string | null {
  const match = skills.find((skill) => skill.name === skillName);
  return match?.path ?? null;
}

export function recommendImplementationSkill(input: {
  workItemType: string;
  skills: ReadonlyArray<Pick<CloudAgentSkillChoice, 'name' | 'path'>>;
  configuredSkillPath?: string | null;
}): { skillPath: string; skillName: string | null; reason: string } {
  const preferences = IMPLEMENTATION_SKILL_PREFERENCES[input.workItemType] ?? ['dev-orchestrator'];
  for (const name of preferences) {
    const path = installedSkillPath(input.skills, name);
    if (!path) continue;
    return {
      skillPath: path,
      skillName: name,
      reason: `${input.workItemType} work uses ${name}.`,
    };
  }

  const configured = input.configuredSkillPath?.trim();
  if (configured) {
    return {
      skillPath: configured,
      skillName: skillNameFromPath(configured),
      reason: `${input.workItemType} work uses the project's development skill.`,
    };
  }

  return {
    skillPath: DEFAULT_DEVELOPMENT_SKILL_PATH,
    skillName: skillNameFromPath(DEFAULT_DEVELOPMENT_SKILL_PATH),
    reason: `${input.workItemType} work uses the default development skill.`,
  };
}

export interface CloudAgentLaunchSelectionInput {
  intent: CloudAgentLaunchIntent;
  recommendedSkillPath: string;
  recommendedModel: string;
  requestedSkillPath?: string | null;
  requestedModel?: string | null;
  allowedSkillPaths: readonly string[];
  allowedModelIds: readonly string[];
  priorSkillPath?: string | null;
  priorModel?: string | null;
}

export type CloudAgentLaunchSelection =
  | { ok: true; skillPath: string; model: string; keptPriorSettings: boolean }
  | { ok: false; error: string };

/**
 * Resume reuses the skill and model saved on the original run.
 * Start and retry use the request, then the recommendation.
 * Retry does not write those choices back onto the original run.
 */
export function resolveCloudAgentLaunchSelection(
  input: CloudAgentLaunchSelectionInput,
): CloudAgentLaunchSelection {
  if (input.intent === 'resume') {
    const skillPath = input.priorSkillPath?.trim() || '';
    const model = input.priorModel?.trim() || '';
    if (!skillPath || !model) {
      return {
        ok: false,
        error: 'Resume needs the skill and model saved on the original run. Retry to choose new ones.',
      };
    }
    return { ok: true, skillPath, model, keptPriorSettings: true };
  }

  const skillPath = input.requestedSkillPath?.trim() || input.recommendedSkillPath;
  const model = input.requestedModel?.trim() || input.recommendedModel;
  const allowedSkills = new Set(input.allowedSkillPaths);
  allowedSkills.add(input.recommendedSkillPath);
  allowedSkills.add(DEFAULT_DEVELOPMENT_SKILL_PATH);
  if (input.priorSkillPath?.trim()) allowedSkills.add(input.priorSkillPath.trim());
  if (!allowedSkills.has(skillPath)) {
    return { ok: false, error: 'Choose a skill from this project.' };
  }

  const allowedModels = new Set(input.allowedModelIds);
  allowedModels.add(input.recommendedModel);
  allowedModels.add(DEFAULT_DEVELOPMENT_MODEL);
  if (input.priorModel?.trim()) allowedModels.add(input.priorModel.trim());
  if (!allowedModels.has(model)) {
    return { ok: false, error: 'Choose a model from the list.' };
  }

  return { ok: true, skillPath, model, keptPriorSettings: false };
}

export function parseCloudAgentLaunchIntent(value: unknown): CloudAgentLaunchIntent | null {
  if (value === undefined || value === null || value === '') return 'start';
  if (value === 'start' || value === 'resume' || value === 'retry') return value;
  return null;
}

export function buildGuidedCloudAgentPrompt(input: {
  title: string;
  skillPath: string;
  skillName: string | null;
  task: string;
  branchName: string;
}): string {
  const invocation = input.skillName ? `/${input.skillName}\n\n` : '';
  const pullRequestTitle = `[APEX] ${input.branchName.replace('feature/', '')}`;
  return [
    `${invocation}A person who is not writing code reported a problem on the site: ${input.title}.`,
    `Load \`${input.skillPath}\` from the repository and follow it.`,
    'Investigate the report, find the cause, and make the code change that fixes it.',
    `Work on branch \`${input.branchName}\` and no other branch.`,
    `Open a pull request titled \`${pullRequestTitle}\` so a developer can review the change.`,
    'Do not change Azure DevOps work items. This report has no work item.',
    '',
    'What they reported:',
    input.task.trim(),
  ].join('\n');
}
