import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { devSessions } from '../db/schema';
import type { RunCheckResult } from '../../shared/types/agentRunLifecycle';
import {
  isLeftoverWorkClean,
  type LeftoverWorkSummary,
} from '../../shared/types/devWorkbench';
import { AzureDevOpsService } from './azureDevOps';
import { logMyWorkSession } from './myWorkSessionLogger';

export interface ComputeLeftoverWorkInput {
  checkResults?: RunCheckResult[] | null;
  prUrl: string | null;
  incompleteAcceptanceCriteria?: string[] | null;
}

export function computeLeftoverWorkSummary(
  input: ComputeLeftoverWorkInput,
): LeftoverWorkSummary | null {
  const summary: LeftoverWorkSummary = {
    failingChecks: (input.checkResults ?? [])
      .filter((result) => result.outcome === 'failed')
      .map((result) => result.kind),
    missingPr: !input.prUrl,
    incompleteAcceptanceCriteria: [...(input.incompleteAcceptanceCriteria ?? [])],
  };

  return isLeftoverWorkClean(summary) ? null : summary;
}

function formatLeftoverItems(summary: LeftoverWorkSummary): string[] {
  return [
    ...summary.failingChecks.map((check) => `Failing check: ${check}`),
    ...(summary.missingPr ? ['No pull request was opened'] : []),
    ...summary.incompleteAcceptanceCriteria.map(
      (criterion) => `Incomplete acceptance criterion: ${criterion}`,
    ),
  ];
}

export function formatLeftoverWorkForAdoComment(
  summary: LeftoverWorkSummary | null | undefined,
  context: { runId: string; completedAt?: Date } = { runId: 'unknown' },
): string {
  if (isLeftoverWorkClean(summary)) return '';

  const completedAt = (context.completedAt ?? new Date()).toISOString();
  return [
    `Cloud Agent leftover work — run ${context.runId} (${completedAt})`,
    '',
    ...formatLeftoverItems(summary!),
  ].join('\n');
}

export function formatLeftoverWorkForResumePrompt(
  summary: LeftoverWorkSummary | null | undefined,
): string {
  if (isLeftoverWorkClean(summary)) return '';

  return [
    'Address the following leftover work from the previous Cloud Agent run:',
    ...formatLeftoverItems(summary!).map((item) => `- ${item}`),
  ].join('\n');
}

export interface PersistLeftoverWorkInput {
  sessionId: string;
  project: string;
  summary: LeftoverWorkSummary | null;
}

export interface PersistLeftoverWorkResult {
  /**
   * True only when this callback wrote a non-clean summary onto a previously
   * null leftover_work column (IS NULL + RETURNING). ADO comments append only
   * on this win so concurrent completion callbacks cannot both comment.
   */
  firstWrite: boolean;
}

export interface PersistLeftoverWorkDeps {
  write: (
    sessionId: string,
    summary: LeftoverWorkSummary | null,
  ) => Promise<PersistLeftoverWorkResult>;
  log: typeof logMyWorkSession;
}

async function writeLeftoverWorkRow(
  sessionId: string,
  summary: LeftoverWorkSummary | null,
): Promise<PersistLeftoverWorkResult> {
  const nowIso = new Date().toISOString();
  if (!summary) {
    await db
      .update(devSessions)
      .set({ leftoverWork: null, updatedAt: nowIso })
      .where(eq(devSessions.id, sessionId));
    return { firstWrite: false };
  }

  const updated = await db
    .update(devSessions)
    .set({ leftoverWork: summary, updatedAt: nowIso })
    .where(and(
      eq(devSessions.id, sessionId),
      sql`${devSessions.leftoverWork} IS NULL`,
    ))
    .returning({ id: devSessions.id });
  return { firstWrite: updated.length > 0 };
}

const defaultPersistDeps: PersistLeftoverWorkDeps = {
  write: writeLeftoverWorkRow,
  log: logMyWorkSession,
};

export async function persistLeftoverWork(
  input: PersistLeftoverWorkInput,
  deps: PersistLeftoverWorkDeps = defaultPersistDeps,
): Promise<PersistLeftoverWorkResult> {
  const result = await deps.write(input.sessionId, input.summary);
  const wrote = !input.summary || result.firstWrite;
  if (wrote) {
    deps.log('leftover_work.persisted', {
      sessionId: input.sessionId,
      project: input.project,
      failingCheckCount: input.summary?.failingChecks.length ?? 0,
      missingPr: input.summary?.missingPr ?? false,
      incompleteAcCount: input.summary?.incompleteAcceptanceCriteria.length ?? 0,
    });
  }
  return result;
}

export interface LeftoverWorkAdoWriter {
  addWorkItemComment(workItemId: number, text: string): Promise<unknown>;
}

export interface WriteLeftoverWorkToAdoInput {
  sessionId: string;
  project: string;
  workItemId: number;
  runId: string;
  summary: LeftoverWorkSummary | null;
  completedAt?: Date;
}

export interface WriteLeftoverWorkToAdoDeps {
  createAdoService: (project: string) => LeftoverWorkAdoWriter;
  log: typeof logMyWorkSession;
}

const defaultAdoDeps: WriteLeftoverWorkToAdoDeps = {
  createAdoService: (project) => new AzureDevOpsService(project),
  log: logMyWorkSession,
};

export async function writeLeftoverWorkToAdo(
  input: WriteLeftoverWorkToAdoInput,
  deps: WriteLeftoverWorkToAdoDeps = defaultAdoDeps,
): Promise<void> {
  const comment = formatLeftoverWorkForAdoComment(input.summary, {
    runId: input.runId,
    completedAt: input.completedAt,
  });
  if (!comment) return;

  try {
    await deps.createAdoService(input.project).addWorkItemComment(input.workItemId, comment);
  } catch {
    deps.log('leftover_work.ado_write_failed', {
      sessionId: input.sessionId,
      project: input.project,
      runId: input.runId,
    }, 'warn');
  }
}
