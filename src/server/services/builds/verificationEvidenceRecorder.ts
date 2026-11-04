/**
 * Verification evidence recorder for build tasks (TBI-021, PBI-022, S6).
 *
 * Order:
 * 1. Load task/revision/run context and check stale attempt before Blob writes.
 * 2. Parse (`parseEvidenceBlock`) and decide (`decideTaskDone`).
 * 3. Redact (`redactText`) every output and row text field.
 * 4. Upload Blob (`putEvidence`).
 * 5. Inside one transaction, re-verify task attempt under a row lock, upsert
 *    `build_verification_rows` on `(buildRevisionId, requirementId)`, and append
 *    `verification.*` build events (`appendBuildEvent`).
 */
import { eq, sql } from 'drizzle-orm';
import type {
  ArtifactRef,
  BuildClassification,
  BuildQualityManifestSnapshot,
  BuildRequirement,
  BuildRiskDecision,
  BuildTaskRole,
  BuildTaskStatus,
  BuildTestEvidence,
  BuildTestRef,
  BuildVerificationRow,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks, buildVerificationRows } from '../../db/schema';
import { describeRuntimeFailure, missingChecksMessage } from '../../../shared/buildRuntimeFailure';
import type { BuildVisualBrief } from '../../../shared/buildVisualBrief';
import { evaluateVisualQualityFromEvidence } from '../buildVisualVerificationService';
import { appendBuildEvent, type AppendBuildEventInput } from '../buildEventsService';
import { redactText, type KnownSecretSource } from '../buildRedactionService';
import {
  buildEvidenceBlobPrefix,
  putEvidence,
  type BuildEvidenceStore,
} from './buildEvidenceStore';
import { parseEvidenceBlock } from './evidenceBlockParser';
import {
  decideTaskDone,
  type DecideTaskDoneResult,
  type OwnedRequirementSpec,
  type VerificationRowWrite,
  type Violation,
} from './verificationEvidenceChecker';

export type RecordTaskEvidenceResult =
  | { stale: true }
  | {
      stale: false;
      outcome: 'done' | 'refused' | 'escalate';
      mayReportDone: boolean;
      violations: Violation[];
      escalation: { reason: string; planPath: string } | null;
    };

export interface VerificationRecorderTaskContext {
  task: {
    id: string;
    buildRevisionId: string;
    taskKey: string;
    role: BuildTaskRole;
    status: BuildTaskStatus;
    attempt: number;
    ownedFiles: string[];
    covers: string[];
  };
  revision: {
    id: string;
    buildRunId: string;
    revisionNumber: number;
    classification: BuildClassification | null;
    requirements: BuildRequirement[];
    riskDecisions: BuildRiskDecision[];
    plan: unknown | null;
  };
  run: {
    id: string;
    qualityManifestSnapshot: BuildQualityManifestSnapshot;
  };
}

export type VerificationRowUpsertRecord = Omit<
  BuildVerificationRow,
  'id' | 'createdAt' | 'updatedAt' | 'carriedFromRevisionNumber'
>;

export interface VerificationRecorderStore {
  loadContext(buildTaskId: string): Promise<VerificationRecorderTaskContext | null>;
  commitTransaction(input: {
    buildTaskId: string;
    attemptNumber: number;
    buildRunId: string;
    buildRevisionId: string;
    rows: VerificationRowUpsertRecord[];
    events: AppendBuildEventInput[];
  }): Promise<{ stale: boolean }>;
}

export interface RecordTaskEvidenceDeps {
  store?: VerificationRecorderStore;
  evidenceStore?: Pick<BuildEvidenceStore, 'putEvidence'>;
  redact?: (input: string) => string;
  knownSecrets?: KnownSecretSource;
  now?: () => string;
  log?: (line: string) => void;
}

function normalizePathForMatch(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/^\.[\\/]+/, '')
    .replace(/\\/g, '/');
}

interface PlanTestEntry {
  subjectId?: unknown;
  testRef?: { path?: unknown } | null;
}

/**
 * Resolves the owned requirement and risk-decision specs for a task.
 * - On the small path (or when both `ownedFiles` and `covers` are empty), the task
 *   owns every requirement and risk decision of the revision.
 * - On the full path, a task owns each ID in `task.covers` or where the plan's test
 *   reference points at a file in `task.ownedFiles`.
 */
export function resolveTaskOwnedSpecs(
  context: VerificationRecorderTaskContext,
): { ownedIds: OwnedRequirementSpec[]; ownedFiles: string[] | null } {
  const { task, revision } = context;
  const isSmallPath =
    revision.classification === 'small' ||
    (task.ownedFiles.length === 0 && task.covers.length === 0);

  const allSpecsById = new Map<string, OwnedRequirementSpec>();
  for (const req of revision.requirements ?? []) {
    allSpecsById.set(req.id, {
      id: req.id,
      kind: req.kind,
      retired: Boolean(req.retired),
    });
  }
  for (const rd of revision.riskDecisions ?? []) {
    allSpecsById.set(rd.id, {
      id: rd.id,
      kind: 'risk_decision',
      retired: false,
    });
  }

  if (isSmallPath) {
    return {
      ownedIds: [...allSpecsById.values()],
      ownedFiles: null,
    };
  }

  const ownedIdSet = new Set<string>(task.covers ?? []);
  const normalizedOwnedFiles = new Set(
    (task.ownedFiles ?? []).map((file) => normalizePathForMatch(file)),
  );

  if (
    revision.plan &&
    typeof revision.plan === 'object' &&
    Array.isArray((revision.plan as { tests?: unknown }).tests)
  ) {
    const planTests = (revision.plan as { tests: PlanTestEntry[] }).tests;
    for (const testEntry of planTests) {
      const subjectId =
        typeof testEntry?.subjectId === 'string' ? testEntry.subjectId : null;
      const refPath =
        typeof testEntry?.testRef?.path === 'string'
          ? normalizePathForMatch(testEntry.testRef.path)
          : null;
      if (subjectId && refPath && normalizedOwnedFiles.has(refPath)) {
        ownedIdSet.add(subjectId);
      }
    }
  }

  const ownedIds: OwnedRequirementSpec[] = [];
  for (const id of ownedIdSet) {
    const existing = allSpecsById.get(id);
    if (existing) {
      ownedIds.push(existing);
    } else if (id.startsWith('RD-')) {
      ownedIds.push({ id, kind: 'risk_decision', retired: false });
    } else if (id.startsWith('DOD-')) {
      ownedIds.push({ id, kind: 'dod', retired: false });
    } else if (id.startsWith('BR-')) {
      ownedIds.push({ id, kind: 'br', retired: false });
    } else if (id.startsWith('NFR-')) {
      ownedIds.push({ id, kind: 'nfr', retired: false });
    } else {
      ownedIds.push({ id, kind: 'ac', retired: false });
    }
  }

  return {
    ownedIds,
    ownedFiles: task.ownedFiles,
  };
}

export function createDrizzleVerificationRecorderStore(): VerificationRecorderStore {
  return {
    async loadContext(buildTaskId: string): Promise<VerificationRecorderTaskContext | null> {
      const [row] = await db
        .select({
          task: buildTasks,
          revision: buildRevisions,
          run: buildRuns,
        })
        .from(buildTasks)
        .innerJoin(buildRevisions, eq(buildRevisions.id, buildTasks.buildRevisionId))
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildTasks.id, buildTaskId))
        .limit(1);

      if (!row) return null;

      return {
        task: {
          id: row.task.id,
          buildRevisionId: row.task.buildRevisionId,
          taskKey: row.task.taskKey,
          role: row.task.role,
          status: row.task.status,
          attempt: row.task.attempt,
          ownedFiles: row.task.ownedFiles ?? [],
          covers: row.task.covers ?? [],
        },
        revision: {
          id: row.revision.id,
          buildRunId: row.revision.buildRunId,
          revisionNumber: row.revision.revisionNumber,
          classification: row.revision.classification ?? null,
          requirements: row.revision.requirements ?? [],
          riskDecisions: row.revision.riskDecisions ?? [],
          plan: row.revision.plan ?? null,
        },
        run: {
          id: row.run.id,
          qualityManifestSnapshot: row.run.qualityManifestSnapshot,
        },
      };
    },

    async commitTransaction(input) {
      return db.transaction(async (tx) => {
        const lockedResult = await tx.execute<{ attempt: number }>(
          sql`SELECT attempt FROM build_tasks WHERE id = ${input.buildTaskId}::uuid FOR UPDATE`,
        );
        const lockedRow = lockedResult.rows[0];
        if (!lockedRow || Number(lockedRow.attempt) !== input.attemptNumber) {
          return { stale: true };
        }

        const nowIso = new Date().toISOString();
        for (const row of input.rows) {
          await tx
            .insert(buildVerificationRows)
            .values({
              buildRevisionId: row.buildRevisionId,
              requirementId: row.requirementId,
              kind: row.kind,
              testTier: row.testTier,
              testRefs: row.testRefs,
              redEvidence: row.redEvidence,
              greenEvidence: row.greenEvidence,
              evidenceBlobRef: row.evidenceBlobRef,
              status: row.status,
              deferralReason: row.deferralReason,
              updatedAt: nowIso,
            })
            .onConflictDoUpdate({
              target: [
                buildVerificationRows.buildRevisionId,
                buildVerificationRows.requirementId,
              ],
              set: {
                kind: row.kind,
                testTier: row.testTier,
                testRefs: row.testRefs,
                redEvidence: row.redEvidence,
                greenEvidence: row.greenEvidence,
                evidenceBlobRef: row.evidenceBlobRef,
                status: row.status,
                deferralReason: row.deferralReason,
                updatedAt: nowIso,
              },
            });
        }

        for (const eventInput of input.events) {
          await appendBuildEvent(eventInput, { executor: tx });
        }

        return { stale: false };
      });
    },
  };
}

const defaultRecorderStore = createDrizzleVerificationRecorderStore();

export async function recordTaskEvidence(
  input: {
    buildTaskId: string;
    attemptNumber: number;
    message: string;
    agentRunId?: string | null;
  },
  deps?: RecordTaskEvidenceDeps,
): Promise<RecordTaskEvidenceResult> {
  const store = deps?.store ?? defaultRecorderStore;
  const evidenceStore: Pick<BuildEvidenceStore, 'putEvidence'> = deps?.evidenceStore ?? {
    putEvidence,
  };
  const redact =
    deps?.redact ??
    ((text: string) =>
      redactText(
        text,
        deps?.knownSecrets ? { knownSecrets: deps.knownSecrets } : undefined,
      ));
  const nowIso = (deps?.now ?? (() => new Date().toISOString()))();
  const log = deps?.log ?? ((line: string) => console.info(line));

  const context = await store.loadContext(input.buildTaskId);
  if (!context || context.task.attempt !== input.attemptNumber) {
    return { stale: true };
  }

  const { task, revision, run } = context;
  const { ownedIds, ownedFiles } = resolveTaskOwnedSpecs(context);
  const parsed = parseEvidenceBlock(input.message);

  let decision: DecideTaskDoneResult;
  let standardsReview: { completed: boolean; findings: string[] } | null = null;
  let visualGateFindings: string[] = [];

  if (!parsed.ok) {
    const activeSpecs = ownedIds.filter((spec) => !spec.retired);
    const failRows: VerificationRowWrite[] = activeSpecs.map((spec) => ({
      requirementId: spec.id,
      kind: spec.kind,
      tier: null,
      status: 'fail',
      testReferences: [],
      red: null,
      green: null,
      deferralReason: null,
    }));
    const violations: Violation[] =
      activeSpecs.length > 0
        ? activeSpecs.map((spec) => ({
            code: 'missing_evidence_entry' as const,
            requirementId: spec.id,
          }))
        : [{ code: 'missing_evidence_entry' as const, requirementId: null }];

    decision = {
      outcome: 'refused',
      mayReportDone: false,
      rows: failRows,
      violations,
      unknownRequirementIds: [],
      escalation: null,
    };
  } else {
    standardsReview = parsed.block.standardsReview;
    decision = decideTaskDone({
      ownedIds,
      block: parsed.block,
      manifest: run.qualityManifestSnapshot,
      ownedFiles,
    });

    if (decision.outcome === 'done') {
      const planRecord = revision.plan as Record<string, unknown> | null;
      const visualBrief = (planRecord?.visualBrief ?? null) as BuildVisualBrief | null;
      const visual = evaluateVisualQualityFromEvidence({
        visualBrief,
        block: parsed.block,
      });
      if (!visual.passed) {
        visualGateFindings = visual.findings;
        decision = {
          ...decision,
          outcome: 'refused',
          mayReportDone: false,
          violations: [
            ...decision.violations,
            ...visual.findings.map((_finding) => ({
              code: 'check_failed' as const,
              requirementId: null,
            })),
          ],
        };
      }
    }
  }

  // Upload redacted Blob evidence before starting the DB transaction
  const upsertRows: VerificationRowUpsertRecord[] = [];
  for (const row of decision.rows) {
    let blobRef: ArtifactRef | null = null;
    if (row.red !== null || row.green !== null) {
      const prefix = buildEvidenceBlobPrefix(
        run.id,
        revision.revisionNumber,
        row.requirementId,
      );
      if (row.red !== null) {
        const redactedRedOutput = redact(row.red.output);
        blobRef = await evidenceStore.putEvidence(prefix, 'red', redactedRedOutput);
      }
      if (row.green !== null) {
        const redactedGreenOutput = redact(row.green.output);
        blobRef = await evidenceStore.putEvidence(prefix, 'green', redactedGreenOutput);
      }
    }

    const redEvidence: BuildTestEvidence | null =
      row.red === null
        ? null
        : {
            commit: row.red.commit,
            recordedAt: nowIso,
            command: redact(row.red.command),
            exitCode: row.red.exitCode,
            passed: 0,
            failed: row.red.failedTests.length,
            summary: redact(row.red.failedTests.join(', ')),
          };

    const greenEvidence: BuildTestEvidence | null =
      row.green === null
        ? null
        : {
            commit: row.green.commit,
            recordedAt: nowIso,
            command: redact(row.green.command),
            exitCode: row.green.exitCode,
            passed: row.green.passedTests.length,
            failed: 0,
            summary: redact(row.green.passedTests.join(', ')),
          };

    const testRefs: BuildTestRef[] = row.testReferences.map((ref) => ({
      path: ref.file,
      name: redact(ref.name),
    }));

    const deferralReason =
      row.deferralReason !== null ? redact(row.deferralReason) : null;

    upsertRows.push({
      buildRevisionId: revision.id,
      requirementId: row.requirementId,
      kind: row.kind,
      testTier: row.tier,
      testRefs,
      redEvidence,
      greenEvidence,
      evidenceBlobRef: blobRef,
      status: row.status,
      deferralReason,
    });
  }

  const correlation = input.agentRunId
    ? { kind: 'agent_run' as const, id: input.agentRunId }
    : null;

  const events: AppendBuildEventInput[] = [];

  if (decision.unknownRequirementIds.length > 0) {
    events.push({
      buildRunId: run.id,
      buildRevisionId: revision.id,
      eventType: 'verification.unknown_requirement',
      severity: 'info',
      message: `Ignored unknown requirement IDs reported by task ${task.taskKey}.`,
      detail: {
        taskKey: task.taskKey,
        attemptNumber: input.attemptNumber,
        unknownRequirementIds: decision.unknownRequirementIds,
      },
      correlation,
      dedupeKey: `verification.unknown_requirement:${task.id}:${input.attemptNumber}`,
    });
  }

  if (standardsReview !== null) {
    events.push({
      buildRunId: run.id,
      buildRevisionId: revision.id,
      eventType: 'verification.standards_review',
      severity: 'info',
      message: `Recorded standards review for task ${task.taskKey}.`,
      detail: {
        taskKey: task.taskKey,
        attemptNumber: input.attemptNumber,
        completed: standardsReview.completed,
        findingCount: standardsReview.findings.length,
      },
      correlation,
      dedupeKey: `verification.standards_review:${task.id}:${input.attemptNumber}`,
    });
  }

  const outcomeDedupeKey =
    !parsed.ok
      ? `verification.refused:${task.id}:${input.attemptNumber}`
      : `verification.outcome:${task.id}:${input.attemptNumber}`;

  if (decision.outcome === 'done') {
    events.push({
      buildRunId: run.id,
      buildRevisionId: revision.id,
      eventType: 'verification.recorded',
      severity: 'info',
      message: `Recorded verification evidence for task ${task.taskKey}.`,
      detail: {
        taskKey: task.taskKey,
        attemptNumber: input.attemptNumber,
        rowCount: decision.rows.length,
      },
      correlation,
      dedupeKey: outcomeDedupeKey,
    });
  } else if (decision.outcome === 'refused') {
    events.push({
      buildRunId: run.id,
      buildRevisionId: revision.id,
      eventType: 'verification.refused',
      severity: 'warn',
      message:
        visualGateFindings.length > 0
          ? `Visual quality checks failed: ${visualGateFindings.join(' ')}`
          : describeRuntimeFailure(input.message) ??
            missingChecksMessage(decision.violations.map((violation) => violation.requirementId)),
      detail: {
        taskKey: task.taskKey,
        attemptNumber: input.attemptNumber,
        violations: decision.violations,
        visualFindings: visualGateFindings.length > 0 ? visualGateFindings : undefined,
      },
      correlation,
      dedupeKey: outcomeDedupeKey,
    });
  } else {
    events.push({
      buildRunId: run.id,
      buildRevisionId: revision.id,
      eventType: 'verification.escalated',
      severity: 'info',
      message: `Task ${task.taskKey} escalated to the full path.`,
      detail: {
        taskKey: task.taskKey,
        attemptNumber: input.attemptNumber,
        planPath: decision.escalation?.planPath ?? null,
      },
      correlation,
      dedupeKey: outcomeDedupeKey,
    });
  }

  const committed = await store.commitTransaction({
    buildTaskId: task.id,
    attemptNumber: input.attemptNumber,
    buildRunId: run.id,
    buildRevisionId: revision.id,
    rows: upsertRows,
    events,
  });

  if (committed.stale) {
    return { stale: true };
  }

  log(
    `[build-verification] ${JSON.stringify({
      buildId: run.id,
      taskKey: task.taskKey,
      attemptNumber: input.attemptNumber,
      outcome: decision.outcome,
      violationCodes: decision.violations.map((v) => v.code),
    })}`,
  );

  return {
    stale: false,
    outcome: decision.outcome,
    mayReportDone: decision.mayReportDone,
    violations: decision.violations,
    escalation: decision.escalation,
  };
}
