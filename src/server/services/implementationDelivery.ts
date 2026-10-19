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

/** Prompt lines that ask the agent to fill pr-description.md in its final message. */
export function buildPullRequestDescriptionInstructions(workItemId: number): string | null {
  const template = loadPullRequestDescriptionTemplate();
  if (!template) return null;
  return [
    `End your final message with the pull request description, wrapped between ${DESCRIPTION_OPEN_TAG} and ${DESCRIPTION_CLOSE_TAG}.`,
    `Use the template below. Keep every heading, and replace each HTML comment with real content for this change. Name the work item as ${buildWorkItemReferenceText(workItemId)}. Stay under ${AGENT_DESCRIPTION_TARGET} characters.`,
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

/**
 * My Work branch name: feature/apex-<workItemId>-<title-slug>.
 * Cloud Agent and local Start Development both use this.
 */
export function implementationBranchName(workItemId: number, workItemTitle: string): string {
  const slug = workItemTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
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
 * Pull-request title and description used by My Work.
 * Title: [APEX] <branch without the feature/ prefix>
 * Description: pr-description.md, with the Work items line filled.
 * A Cloud Agent final message wrapped in pr-description tags replaces that skeleton.
 */
export function buildImplementationPullRequestText(input: {
  branchName: string;
  workItemId: number | null;
  workItemTitle?: string | null;
  agentDescription?: string | null;
}): { title: string; description: string } {
  const title = `[APEX] ${input.branchName.replace('feature/', '')}`.slice(0, TITLE_LIMIT);
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
