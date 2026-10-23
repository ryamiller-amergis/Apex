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
    skillName: 'bug-fix',
  },
];

function branchSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Site report branch. With a Bug it matches My Work: feature/apex-<bugId>-<problem>.
 * The slug comes from the Problem section so the page URL does not fill the name.
 */
export function guidedSiteIssueBranchName(input: {
  sessionId: string;
  task: string;
  bugWorkItemId?: number | null;
}): string {
  const report = parseSiteIssueReport(input.task);
  const slug = branchSlug(report.problem || input.task);
  const prefix = input.bugWorkItemId
    ? `feature/apex-${input.bugWorkItemId}`
    : `feature/apex-site-${input.sessionId.replace(/-/g, '').slice(0, 6) || 'issue'}`;
  return slug ? `${prefix}-${slug}` : prefix;
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

/**
 * Site reports do not ask the person to pick a skill.
 * An installed bug-fix skill wins, then the project's development skill,
 * then dev-orchestrator, then whichever skill the project has installed.
 */
export function recommendGuidedSiteSkill(input: {
  skills: ReadonlyArray<Pick<CloudAgentSkillChoice, 'name' | 'path'>>;
  configuredSkillPath?: string | null;
}): { skillPath: string; skillName: string | null } {
  const bugFix = installedSkillPath(input.skills, 'bug-fix');
  if (bugFix) return { skillPath: bugFix, skillName: 'bug-fix' };
  const configured = input.configuredSkillPath?.trim();
  if (configured) {
    return { skillPath: configured, skillName: skillNameFromPath(configured) };
  }
  const preferred = installedSkillPath(input.skills, 'dev-orchestrator');
  if (preferred) return { skillPath: preferred, skillName: 'dev-orchestrator' };
  const installed = input.skills.find((skill) => skill.path.trim());
  if (installed) return { skillPath: installed.path, skillName: installed.name };
  return {
    skillPath: DEFAULT_DEVELOPMENT_SKILL_PATH,
    skillName: skillNameFromPath(DEFAULT_DEVELOPMENT_SKILL_PATH),
  };
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

/** Keeps site-report Bugs out of the normal investigation backlog. */
export const SITE_ISSUE_BUG_TAGS = ['prod-issue'] as const;

export interface SiteIssueReportSections {
  page: string;
  problem: string;
  steps: string;
  expected: string;
  actual: string;
}

const SITE_ISSUE_SECTION_NAMES = ['page', 'problem', 'steps', 'expected', 'actual'] as const;

/** Reads the report form headings. Text outside those headings stays unused. */
export function parseSiteIssueReport(task: string): SiteIssueReportSections {
  const sections: Record<(typeof SITE_ISSUE_SECTION_NAMES)[number], string[]> = {
    page: [],
    problem: [],
    steps: [],
    expected: [],
    actual: [],
  };
  let current: (typeof SITE_ISSUE_SECTION_NAMES)[number] | null = null;
  for (const line of task.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^(Page|Problem|Steps|Expected|Actual):\s*(.*)$/i.exec(line);
    if (heading) {
      const name = heading[1].toLowerCase() as (typeof SITE_ISSUE_SECTION_NAMES)[number];
      current = name;
      if (heading[2].trim()) sections[name].push(heading[2].trim());
      continue;
    }
    if (current) sections[current].push(line);
  }
  return {
    page: sections.page.join('\n').trim(),
    problem: sections.problem.join('\n').trim(),
    steps: sections.steps.join('\n').trim(),
    expected: sections.expected.join('\n').trim(),
    actual: sections.actual.join('\n').trim(),
  };
}

export const SITE_ISSUE_MAX_IMAGES = 3;
export const SITE_ISSUE_MAX_IMAGE_BYTES = 400 * 1024;

const SITE_ISSUE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type SiteIssueImageType = (typeof SITE_ISSUE_IMAGE_TYPES)[number];

export interface SiteIssueImage {
  name: string;
  mimeType: SiteIssueImageType;
  /** Base64 file bytes, without a data-URL prefix. */
  data: string;
}

function siteIssueImageBytes(data: string): number | null {
  const normalized = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return null;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return (normalized.length * 3) / 4 - padding;
}

/** Accepts a missing list. Rejects anything that is not a few small screenshots. */
export function parseSiteIssueImages(
  value: unknown,
): { ok: true; images: SiteIssueImage[] } | { ok: false; error: string } {
  if (value == null) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'Screenshots must be a list of images.' };
  if (value.length > SITE_ISSUE_MAX_IMAGES) {
    return { ok: false, error: `Add up to ${SITE_ISSUE_MAX_IMAGES} screenshots.` };
  }
  const images: SiteIssueImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Each screenshot needs a name, type, and image data.' };
    }
    const record = item as { name?: unknown; mimeType?: unknown; data?: unknown };
    const name = typeof record.name === 'string' ? record.name.trim().slice(0, 80) : '';
    const mimeType = record.mimeType;
    const data = typeof record.data === 'string' ? record.data.replace(/\s+/g, '') : '';
    if (!name || !data) {
      return { ok: false, error: 'Each screenshot needs a name, type, and image data.' };
    }
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      return { ok: false, error: 'Screenshots must be PNG, JPEG, or WebP.' };
    }
    const bytes = siteIssueImageBytes(data);
    if (bytes == null || bytes <= 0 || bytes > SITE_ISSUE_MAX_IMAGE_BYTES) {
      return { ok: false, error: 'Each screenshot must be 400 KB or smaller.' };
    }
    images.push({ name, mimeType, data });
  }
  return { ok: true, images };
}

export function parseCloudAgentLaunchIntent(value: unknown): CloudAgentLaunchIntent | null {
  if (value === undefined || value === null || value === '') return 'start';
  if (value === 'start' || value === 'resume' || value === 'retry') return value;
  return null;
}

/** Extra instructions a developer can add when starting or retrying a cloud agent. */
export const CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS = 4000;

export function parseCloudAgentCustomPrompt(
  value: unknown,
): { ok: true; customPrompt: string | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, customPrompt: null };
  if (typeof value !== 'string') return { ok: false, error: 'Custom prompt must be text.' };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, customPrompt: null };
  if (trimmed.length > CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      error: `Custom prompt must be ${CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS} characters or fewer.`,
    };
  }
  return { ok: true, customPrompt: trimmed };
}

/**
 * Resume keeps the instructions saved on the original run.
 * Start and retry use the text from this request.
 */
export function customPromptForCloudAgentLaunch(input: {
  intent: CloudAgentLaunchIntent;
  requested: unknown;
  priorCustomPrompt?: string | null;
}): { ok: true; customPrompt: string | null } | { ok: false; error: string } {
  if (input.intent === 'resume') {
    return { ok: true, customPrompt: input.priorCustomPrompt?.trim() || null };
  }
  return parseCloudAgentCustomPrompt(input.requested);
}

/** Places the developer's extra instructions after the generated kickoff. */
export function injectCloudAgentCustomPrompt(
  prompt: string,
  customPrompt: string | null | undefined,
): string {
  const extra = customPrompt?.trim();
  if (!extra) return prompt;
  return [
    prompt.trimEnd(),
    `Additional instructions from the developer who started this run:\n${extra}`,
  ].join('\n\n');
}

export function buildGuidedCloudAgentPrompt(input: {
  title: string;
  skillPath: string;
  skillName: string | null;
  task: string;
  branchName: string;
  imageCount?: number;
  bugWorkItemId?: number | null;
  bugUrl?: string | null;
  /** The repository's pull request description instructions, when it has a template. */
  pullRequestInstructions?: string | null;
}): string {
  const invocation = input.skillName ? `/${input.skillName}\n\n` : '';
  const pullRequestTitle = `[APEX] ${input.branchName.replace('feature/', '')}`;
  const imageCount = input.imageCount ?? 0;
  const bugLine = input.bugWorkItemId
    ? `An Azure DevOps Bug already exists: #${input.bugWorkItemId}${input.bugUrl ? ` ${input.bugUrl}` : ''}. It holds the same report. Use it as the bug work item id, and mention it in the pull request. Do not change its state, tags, or fields.`
    : 'Do not change Azure DevOps work items. This report has no work item.';
  const screenshotLines = imageCount > 0
    ? [
      `This message includes ${imageCount} screenshot${imageCount === 1 ? '' : 's'} from the person who reported it. They show what the person saw. Compare them with what the code renders to confirm the problem and find the page or component.`,
      'If your fix changes what the page shows, check the fixed page in a browser when you can run the app. Describe what you saw in the pull request, and attach a screenshot when your tools allow. If you cannot run the app, say how you confirmed the fix instead.',
    ]
    : [];
  return [
    `${invocation}A person who does not write code reported a problem on the site: ${input.title}.`,
    `Load \`${input.skillPath}\` from the repository and follow it, with these changes because nobody is watching this run:`,
    '- Do not wait for approval. Where the skill asks for approval of a findings or fix plan, write that plan into the pull request description and continue.',
    '- If you cannot reproduce the problem, cannot find its cause with high confidence, or the expected behavior is unclear, do not change production code. End with your findings and the questions a developer must answer.',
    '- Open the pull request yourself. Do not hand off to another skill or ask for a new chat.',
    '',
    'Fix the cause, not the first place the symptom shows. Change only what the report needs.',
    'Add a regression test that fails without the fix and passes with it. Run the relevant tests and lint before opening the pull request.',
    ...screenshotLines,
    '',
    `Work on branch \`${input.branchName}\` and no other branch.`,
    input.pullRequestInstructions?.trim()
      || `Open a pull request titled \`${pullRequestTitle}\` so a developer can review the change. Describe the cause, the fix, and how you tested it.`,
    bugLine,
    '',
    'What they reported:',
    input.task.trim(),
  ].join('\n');
}
