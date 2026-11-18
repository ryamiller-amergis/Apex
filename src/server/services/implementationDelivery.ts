import fs from 'fs';
import path from 'path';
import { buildWorkItemReferenceText } from './workItemPrLinkService';

const TITLE_LIMIT = 400;
/** Azure DevOps rejects a pull-request description longer than this. */
const DESCRIPTION_LIMIT = 4_000;
const AGENT_DESCRIPTION_TARGET = 3_500;
const DESCRIPTION_OPEN_TAG = '<pr-description>';
const DESCRIPTION_CLOSE_TAG = '</pr-description>';
const FALLBACK_DESCRIPTION = 'Automated implementation via APEX dev workbench.';

let templateCache: string | null | undefined;

function resolveTemplatePath(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../pr-description.md'),
    path.resolve(__dirname, '../../pr-description.md'),
    path.resolve(process.cwd(), 'pr-description.md'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Repo-root pr-description.md. Cached per process. Null when the file is not deployed. */
export function loadPullRequestDescriptionTemplate(): string | null {
  if (templateCache !== undefined) return templateCache;
  const templatePath = resolveTemplatePath();
  if (!templatePath) {
    console.warn('[implementation-delivery] pr-description.md was not found; pull requests use the one-line description');
    templateCache = null;
    return templateCache;
  }
  templateCache = fs.readFileSync(templatePath, 'utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim() || null;
  return templateCache;
}

/**
 * Prompt lines that tell the agent to open the pull request.
 * Title, description, and label are written by the agent, not by Apex after the run.
 */
export function buildPullRequestDescriptionInstructions(input: {
  workItemId: number;
  pullRequestTitle: string;
  pullRequestLabel: string;
}): string | null {
  const template = loadPullRequestDescriptionTemplate();
  if (!template) return null;
  return [
    `Open a pull request titled \`${input.pullRequestTitle}\`.`,
    `Use the description below. Keep every heading, and replace each HTML comment with real content for this change. Name the work item as ${buildWorkItemReferenceText(input.workItemId)}. Stay under ${AGENT_DESCRIPTION_TARGET} characters.`,
    `Add the pull request label \`${input.pullRequestLabel}\`.`,
    '```markdown',
    template,
    '```',
  ].join('\n\n');
}

/**
 * Prompt lines for a run whose pull request Apex opens as another person.
 * The agent pushes the branch and returns the description in its final message.
 */
export function buildApexOpensPullRequestInstructions(input: { workItemId: number }): string {
  const template = loadPullRequestDescriptionTemplate();
  const lines = [
    'Commit and push your work to the branch. Do not open a pull request: Apex opens it when you finish.',
    `End your final message with the pull request description between ${DESCRIPTION_OPEN_TAG} and ${DESCRIPTION_CLOSE_TAG}. Name the work item as ${buildWorkItemReferenceText(input.workItemId)}. Stay under ${AGENT_DESCRIPTION_TARGET} characters.`,
  ];
  if (!template) return lines.join('\n\n');
  return [
    ...lines,
    'Use the description below. Keep every heading, and replace each HTML comment with real content for this change.',
    '```markdown',
    template,
    '```',
  ].join('\n\n');
}

/** The description between the pr-description tags in the agent's final message. */
export function extractAgentPullRequestDescription(text: string | null | undefined): string | null {
  if (!text) return null;
  const start = text.lastIndexOf(DESCRIPTION_OPEN_TAG);
  if (start < 0) return null;
  const end = text.indexOf(DESCRIPTION_CLOSE_TAG, start);
  if (end < 0) return null;
  const body = text
    .slice(start + DESCRIPTION_OPEN_TAG.length, end)
    .trim()
    .replace(/^```(?:markdown|md)?\s*\n/, '')
    .replace(/\n```$/, '')
    .trim();
  return body || null;
}

function titleSlug(workItemTitle: string): string {
  return workItemTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Prefix for a Cloud Agent branch. A bug, including a production issue, is
 * `bug/<id>-<name>`. Other types use a short prefix from the type name.
 */
export function cloudAgentBranchPrefix(workItemType: string): string {
  const type = workItemType.trim().toLowerCase();
  if (type === 'bug' || type === 'production bug' || type === 'production issue') return 'bug';
  if (type === 'feature') return 'feat';
  if (type === 'product backlog item') return 'pbi';
  if (type === 'technical backlog item') return 'tbi';
  const slug = type.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'change';
}

/** Cloud Agent branch: `<prefix>/<workItemId>-<title-slug>`. */
export function cloudAgentBranchName(
  workItemId: number,
  workItemTitle: string,
  workItemType: string,
): string {
  const prefix = cloudAgentBranchPrefix(workItemType);
  const slug = titleSlug(workItemTitle);
  return slug ? `${prefix}/${workItemId}-${slug}` : `${prefix}/${workItemId}`;
}

/** Names of Azure DevOps teams or groups, one per line or comma. */
export function parseReviewerList(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : [];
  const seen = new Set<string>();
  const reviewers: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const trimmed = part.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    reviewers.push(trimmed);
  }
  return reviewers;
}

/**
 * Local Start Development branch name: feature/apex-<workItemId>-<title-slug>.
 * Cloud Agent uses cloudAgentBranchName so a bug is not named feat/.
 */
export function implementationBranchName(workItemId: number, workItemTitle: string): string {
  const slug = titleSlug(workItemTitle);
  return slug
    ? `feature/apex-${workItemId}-${slug}`
    : `feature/apex-${workItemId}`;
}

function descriptionFromTemplate(workItemId: number | null, workItemTitle?: string | null): string {
  const template = loadPullRequestDescriptionTemplate();
  const reference = workItemId ? buildWorkItemReferenceText(workItemId) : null;
  if (!template) {
    if (!reference) return FALLBACK_DESCRIPTION;
    return `${FALLBACK_DESCRIPTION}\n\nWork item: ${reference}`;
  }
  if (!reference) return template;
  const title = workItemTitle?.trim();
  const line = title ? `Work items: ${reference} — ${title}` : `Work items: ${reference}`;
  if (/^Work items:.*$/m.test(template)) {
    return template.replace(/^Work items:.*$/m, line);
  }
  return `${line}\n\n${template}`;
}

/**
 * Pull-request title: `<work item type> <id>: <title>` when both the id and a real
 * title are known, so it reads like a sentence instead of a branch slug. Falls back to
 * `[APEX] <branch without the feature/ prefix>` when there is no title to build from.
 */
export function buildPullRequestTitle(input: {
  branchName: string;
  workItemId: number | null;
  workItemTitle?: string | null;
  workItemType?: string | null;
}): string {
  const workItemTitle = input.workItemTitle?.trim();
  if (input.workItemId && workItemTitle) {
    const typeLabel = input.workItemType?.trim() || 'Work item';
    return `${typeLabel} ${input.workItemId}: ${workItemTitle}`;
  }
  return `[APEX] ${input.branchName.replace(/^[^/]+\//, '')}`;
}

/**
 * Pull-request title and description used by My Work.
 * Description: pr-description.md, with the Work items line filled.
 * A Cloud Agent final message wrapped in pr-description tags replaces that skeleton.
 */
export function buildImplementationPullRequestText(input: {
  branchName: string;
  workItemId: number | null;
  workItemTitle?: string | null;
  workItemType?: string | null;
  agentDescription?: string | null;
}): { title: string; description: string } {
  const title = buildPullRequestTitle(input).slice(0, TITLE_LIMIT);
  const reference = input.workItemId ? buildWorkItemReferenceText(input.workItemId) : null;
  const filled = input.agentDescription?.trim();
  const description = filled
    ? (reference && !filled.includes(reference) ? `${filled}\n\nWork item: ${reference}` : filled)
    : descriptionFromTemplate(input.workItemId, input.workItemTitle);
  return {
    title,
    description: description.slice(0, DESCRIPTION_LIMIT),
  };
}
