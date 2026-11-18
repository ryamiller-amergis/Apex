/**
 * The Azure DevOps work item a step acts on, and its text for an agent prompt.
 *
 * A V2 worker has no Azure DevOps credential, so App Service reads the item with its PAT and the
 * prompt carries it.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import { playbookRuns, playbookStepRuns } from '../../db/schema';
import type { PlaybookGraph } from '../../../shared/types/playbook';
import { AzureDevOpsService } from '../azureDevOps';
import type { PlaybookStepExecutionContext } from './stepRuns';

const FIELD_MAX_CHARS = 8_000;
const COMMENT_MAX_CHARS = 2_000;
const MAX_COMMENTS = 20;

export function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Ancestors of a node, nearest first. */
export function ancestorsNearestFirst(graph: PlaybookGraph | undefined, stepId: string): string[] {
  if (!graph) return [];
  const baseId = stepId.split('#')[0];
  const ordered: string[] = [];
  const seen = new Set<string>([baseId]);
  let frontier = [baseId];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of graph.edges) {
        if (edge.to !== id || seen.has(edge.from)) continue;
        seen.add(edge.from);
        ordered.push(edge.from);
        next.push(edge.from);
      }
    }
    frontier = next;
  }
  return ordered;
}

/** The nearest earlier step's `workItemId`, else the run input's. */
export async function inferWorkItemId(context: PlaybookStepExecutionContext): Promise<number | null> {
  const ancestors = ancestorsNearestFirst(context.graph, context.stepId);
  if (ancestors.length) {
    const rows = await db.select({
      stepId: playbookStepRuns.stepId,
      output: playbookStepRuns.outputInline,
      completedAt: playbookStepRuns.completedAt,
    }).from(playbookStepRuns).where(and(
      eq(playbookStepRuns.runId, context.runId),
      eq(playbookStepRuns.status, 'completed'),
    ));
    for (const ancestor of ancestors) {
      const found = rows
        .filter((row) => row.stepId === ancestor || row.stepId.startsWith(`${ancestor}#`))
        .sort((a, b) => String(b.completedAt ?? '').localeCompare(String(a.completedAt ?? '')))
        .map((row) => positiveInteger((row.output as Record<string, unknown> | null)?.workItemId))
        .find((id): id is number => id !== null);
      if (found) return found;
    }
  }
  const [run] = await db.select({ runInput: playbookRuns.runInput })
    .from(playbookRuns)
    .where(eq(playbookRuns.id, context.runId))
    .limit(1);
  return positiveInteger((run?.runInput as Record<string, unknown> | null)?.workItemId);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '[image: $1]')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

type WorkItemInvestigationContext = NonNullable<
  Awaited<ReturnType<AzureDevOpsService['getWorkItemInvestigationContext']>>
>;

export function formatWorkItemPromptSection(item: WorkItemInvestigationContext): string {
  const lines = [`## Azure DevOps work item ${item.id}`, '', `Link: ${item.url}`, ''];
  for (const [label, value] of Object.entries(item.fields)) {
    const text = clip(htmlToText(value), FIELD_MAX_CHARS);
    if (!text) continue;
    lines.push(text.includes('\n') ? `**${label}:**\n${text}\n` : `**${label}:** ${text}`);
  }
  if (item.attachments.length) {
    lines.push('', '**Attachments** (names only; they need Azure DevOps sign-in to open):');
    for (const attachment of item.attachments) lines.push(`- ${attachment.name}`);
  }
  if (item.hyperlinks.length) {
    lines.push('', '**Links:**');
    for (const link of item.hyperlinks) lines.push(`- ${link}`);
  }
  const comments = item.comments.slice(-MAX_COMMENTS);
  if (comments.length) {
    lines.push('', '**Comments** (oldest first):');
    for (const comment of comments) {
      const header = [comment.createdBy, comment.createdDate].filter(Boolean).join(', ');
      lines.push(`- ${header ? `${header}: ` : ''}${clip(htmlToText(comment.text), COMMENT_MAX_CHARS)}`);
    }
  }
  return lines.join('\n').trim();
}

/**
 * The work item section for the step's prompt, or null when the run names no work item.
 * Throws when Azure DevOps cannot return the named item.
 */
export async function workItemPromptSection(
  context: PlaybookStepExecutionContext,
): Promise<string | null> {
  const workItemId = await inferWorkItemId(context);
  if (!workItemId) return null;
  const item = await new AzureDevOpsService(context.project).getWorkItemInvestigationContext(workItemId);
  if (!item) throw new Error(`Work item ${workItemId} was not found in Azure DevOps.`);
  return formatWorkItemPromptSection(item);
}
