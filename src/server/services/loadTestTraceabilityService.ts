/**
 * FEAT-010 — Requirement load-test traceability
 *
 * Owns: list-by-requirement query + append-only ADO activity on terminal runs.
 * Does not write run lifecycle fields except the two activity idempotency columns.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { loadTestRuns, loadTests } from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';
import type {
  LatestRunSummary,
  LoadTestRequirementLinkSummary,
  RequirementRef,
  RunStatus,
} from '../../shared/types/loadTest';

const TERMINAL_ACTIVITY_STATUSES = new Set<RunStatus>([
  'passed',
  'failed',
  'errored',
  'cancelled',
]);

export type RequirementRefKind = RequirementRef['kind'];

export type ListByRequirementInput = {
  projectId: string;
  kind: RequirementRefKind;
  id: string;
};

export type RecordRunCompletionActivityInput = {
  projectId: string;
  runId: string;
};

export type TraceabilityCommentWriter = {
  addWorkItemComment: (workItemId: number, text: string) => Promise<{ id: number }>;
};

let commentWriterFactory: ((projectId: string) => TraceabilityCommentWriter) | null = null;

/** Test seam — inject ADO comment writer without constructing AzureDevOpsService. */
export function setTraceabilityCommentWriterFactory(
  factory: ((projectId: string) => TraceabilityCommentWriter) | null,
): void {
  commentWriterFactory = factory;
}

function getCommentWriter(projectId: string): TraceabilityCommentWriter {
  if (commentWriterFactory) {
    return commentWriterFactory(projectId);
  }
  const ado = new AzureDevOpsService(projectId);
  return {
    addWorkItemComment: (workItemId, text) => ado.addWorkItemComment(workItemId, text),
  };
}

function mapLatestRun(row: typeof loadTestRuns.$inferSelect): LatestRunSummary {
  return {
    runId: row.id,
    status: row.status,
    overallResult: row.overallResult ?? null,
    completedAt: row.completedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

/**
 * List project-scoped load-test definitions linked to a requirement ref,
 * with the latest run summary (or null when never run).
 */
export async function listByRequirement(
  input: ListByRequirementInput,
): Promise<LoadTestRequirementLinkSummary[]> {
  const { projectId, kind, id } = input;
  if (!kind || !id?.trim()) {
    return [];
  }

  const definitions = await db
    .select({
      id: loadTests.id,
      name: loadTests.name,
      requirementRef: loadTests.requirementRef,
    })
    .from(loadTests)
    .where(
      and(
        eq(loadTests.projectId, projectId),
        sql`${loadTests.requirementRef}->>'kind' = ${kind}`,
        sql`${loadTests.requirementRef}->>'id' = ${id}`,
      ),
    );

  if (definitions.length === 0) {
    return [];
  }

  const defIds = definitions.map((d) => d.id);
  const runRows = await db
    .select()
    .from(loadTestRuns)
    .where(
      and(eq(loadTestRuns.projectId, projectId), inArray(loadTestRuns.loadTestId, defIds)),
    )
    .orderBy(desc(loadTestRuns.createdAt));

  const latestByDef = new Map<string, LatestRunSummary>();
  for (const row of runRows) {
    if (!latestByDef.has(row.loadTestId)) {
      latestByDef.set(row.loadTestId, mapLatestRun(row));
    }
  }

  return definitions.map((def) => ({
    definitionId: def.id,
    name: def.name,
    requirementRef: (def.requirementRef ?? {
      kind,
      id,
    }) as RequirementRef,
    latestRun: latestByDef.get(def.id) ?? null,
  }));
}

function buildActivityComment(params: {
  definitionName: string;
  status: RunStatus;
  runId: string;
  completedAt: string | null | undefined;
}): string {
  const when = params.completedAt ?? new Date().toISOString();
  return (
    `Load test "${params.definitionName}" finished: ${params.status} ` +
    `(run ${params.runId}) at ${when}. Open in Apex: /load-tests/runs/${params.runId}`
  );
}

/**
 * After terminal ingest, append an ADO discussion comment on the linked work item.
 * Idempotent via requirement_activity_* columns. Never throws to the ingest caller —
 * failures are logged only (PBI-013 AC-1).
 */
export async function recordRunCompletionActivity(
  input: RecordRunCompletionActivityInput,
): Promise<void> {
  const { projectId, runId } = input;
  try {
    const runs = await db
      .select()
      .from(loadTestRuns)
      .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)))
      .limit(1);

    const run = runs[0];
    if (!run) {
      return;
    }

    if (!TERMINAL_ACTIVITY_STATUSES.has(run.status)) {
      return;
    }

    if (run.requirementActivityExternalId) {
      return;
    }

    const defs = await db
      .select({
        name: loadTests.name,
        requirementRef: loadTests.requirementRef,
      })
      .from(loadTests)
      .where(and(eq(loadTests.id, run.loadTestId), eq(loadTests.projectId, projectId)))
      .limit(1);

    const def = defs[0];
    const ref = def?.requirementRef;
    if (!def || !ref || ref.kind !== 'ado_work_item' || !ref.id) {
      return;
    }

    const workItemId = Number(ref.id);
    if (!Number.isFinite(workItemId)) {
      console.error(
        JSON.stringify({
          event: 'load_test.traceability.activity_failed',
          reason: 'invalid_work_item_id',
          projectId,
          runId,
          workItemId: ref.id,
        }),
      );
      return;
    }

    const text = buildActivityComment({
      definitionName: def.name,
      status: run.status,
      runId: run.id,
      completedAt: run.completedAt,
    });

    const writer = getCommentWriter(projectId);
    const comment = await writer.addWorkItemComment(workItemId, text);
    const postedAt = new Date().toISOString();

    await db
      .update(loadTestRuns)
      .set({
        requirementActivityExternalId: String(comment.id),
        requirementActivityPostedAt: postedAt,
        updatedAt: postedAt,
      })
      .where(and(eq(loadTestRuns.id, runId), eq(loadTestRuns.projectId, projectId)));

    console.info(
      JSON.stringify({
        event: 'load_test.traceability.activity_posted',
        projectId,
        runId,
        workItemId,
        commentId: comment.id,
      }),
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'load_test.traceability.activity_failed',
        projectId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Fire-and-forget wrapper so ingest acknowledgment is not delayed (PBI-013 NFR). */
export function scheduleRunCompletionActivity(input: RecordRunCompletionActivityInput): void {
  void recordRunCompletionActivity(input);
}
