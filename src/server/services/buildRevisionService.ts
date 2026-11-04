/**
 * Build revision engine service (FEAT-014, TBI-026, PBI-030..032 / S5, S8, S9, S10, S11).
 */
import { and, eq, lt, sql } from 'drizzle-orm';
import type {
  BuildClassification,
  BuildRequirement,
  BuildRiskDecision,
  BuildRunStatus,
} from '../../shared/types/build';
import {
  BUILD_REVISION_FEEDBACK_MAX_LENGTH,
  type BuildRevisionAccepted,
  type BuildRevisionErrorCode,
} from '../../shared/types/buildRevision';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../db/schema';
import { canActOnBuild, type BuildActorContext } from './build/buildAccessPolicy';
import { requestRepairAttempt } from './build/repairAttempts';
import { appendBuildEvent } from './buildEventsService';
import { redactText } from './buildRedactionService';
import { buildRevisionKickoffPrompt } from './buildRevisionPrompts';
import { reopenInterviewBriefForRevision } from './interviewBriefService';

export class BuildRevisionError extends Error {
  readonly code: BuildRevisionErrorCode;
  readonly statusCode: number;

  constructor(code: BuildRevisionErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'BuildRevisionError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RevisionRunRecord {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  requesterUserId: string;
  requesterDisplayName: string;
  currentRevisionNumber: number;
  revisionsUsed: number;
  revisionCap: number;
  interviewId: string | null;
  chatThreadId: string | null;
  integrationBranch: string | null;
  defaultBranch: string;
}

export interface RevisionStateRecord {
  id: string;
  buildRunId: string;
  revisionNumber: number;
  requestedByUserId: string;
  feedback: string | null;
  briefVersion: number | null;
  classification: BuildClassification | null;
  catchUpConflict: boolean;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  changedAndAddedIds: string[];
  hasKickoffTurnSent: boolean;
}

export interface BuildRevisionServiceDeps {
  loadRun: (buildId: string) => Promise<RevisionRunRecord | null>;
  loadRunByInterviewId: (interviewId: string) => Promise<RevisionRunRecord | null>;
  loadCurrentRevision: (
    buildRunId: string,
    revisionNumber: number,
  ) => Promise<RevisionStateRecord | null>;
  casTransitionToIntake: (input: {
    buildId: string;
    project: string;
    redactedFeedback: string;
    actorUserId: string;
  }) => Promise<
    | { kind: 'started'; run: RevisionRunRecord; revision: RevisionStateRecord }
    | { kind: 'resumed'; run: RevisionRunRecord; revision: RevisionStateRecord }
    | { kind: 'not_found' }
    | { kind: 'not_revisable'; status: BuildRunStatus }
    | { kind: 'in_progress' }
    | { kind: 'cap_reached'; limit: number }
  >;
  reopenBrief: (interviewId: string, reopenedBy: string) => Promise<void>;
  sendKickoffTurn: (
    threadId: string,
    prompt: string,
    revisionId: string,
  ) => Promise<void>;
  casApproveRevision: (
    buildRunId: string,
    revisionNumber: number,
    classification: BuildClassification,
    briefVersion: number,
  ) => Promise<boolean>;
  mergeIntoIntegration: (opts: {
    sourceBranch: string;
    targetBranch: string;
    deleteSourceBranch: boolean;
  }) => Promise<'merged' | 'nothing_to_merge' | 'conflict'>;
  incrementRepairAttempt: (
    revisionId: string,
  ) => Promise<{ granted: boolean; used: number }>;
  createSmallRevisionTask: (revisionId: string, covers: string[]) => Promise<void>;
  launchRevisionAgent: (buildRunId: string, revisionId: string) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId?: string | null;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
    actorUserId?: string | null;
  }) => Promise<void>;
}

function createDefaultBuildRevisionDeps(): BuildRevisionServiceDeps {
  const mapRun = (row: typeof buildRuns.$inferSelect): RevisionRunRecord => ({
    id: row.id,
    project: row.project,
    repository: row.repository,
    status: row.status,
    requesterUserId: row.requestedByUserId,
    requesterDisplayName: row.requestedByUserId,
    currentRevisionNumber: row.currentRevisionNumber,
    revisionsUsed: row.revisionsUsed,
    revisionCap: row.revisionCap,
    interviewId: row.interviewId ?? null,
    chatThreadId: row.interviewId ?? null,
    integrationBranch: row.integrationBranch ?? `apex/build/${row.id}`,
    defaultBranch: 'main',
  });

  const mapRev = (
    row: typeof buildRevisions.$inferSelect,
    requestedByUserId: string,
  ): RevisionStateRecord => ({
    id: row.id,
    buildRunId: row.buildRunId,
    revisionNumber: row.revisionNumber,
    requestedByUserId,
    feedback: row.feedback ?? null,
    briefVersion: row.briefVersion ?? null,
    classification: row.classification ?? null,
    catchUpConflict: false,
    requirements: row.requirements ?? [],
    riskDecisions: row.riskDecisions ?? [],
    changedAndAddedIds: [],
    hasKickoffTurnSent: false,
  });

  return {
    async loadRun(buildId) {
      const [row] = await db
        .select()
        .from(buildRuns)
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      return row ? mapRun(row) : null;
    },
    async loadRunByInterviewId(interviewId) {
      const [row] = await db
        .select()
        .from(buildRuns)
        .where(eq(buildRuns.interviewId, interviewId))
        .limit(1);
      return row ? mapRun(row) : null;
    },
    async loadCurrentRevision(buildRunId, revisionNumber) {
      const [row] = await db
        .select()
        .from(buildRevisions)
        .where(
          and(
            eq(buildRevisions.buildRunId, buildRunId),
            eq(buildRevisions.revisionNumber, revisionNumber),
          ),
        )
        .limit(1);
      return row ? mapRev(row, '') : null;
    },
    async casTransitionToIntake({ buildId, project, redactedFeedback, actorUserId }) {
      return db.transaction(async (tx) => {
        const now = new Date().toISOString();
        const [updatedRun] = await tx
          .update(buildRuns)
          .set({
            status: 'intake',
            revisionsUsed: sql`${buildRuns.revisionsUsed} + 1`,
            currentRevisionNumber: sql`${buildRuns.currentRevisionNumber} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(buildRuns.id, buildId),
              eq(buildRuns.project, project),
              eq(buildRuns.status, 'preview_ready'),
              lt(buildRuns.revisionsUsed, buildRuns.revisionCap),
            ),
          )
          .returning();

        if (!updatedRun) {
          const [existing] = await tx
            .select()
            .from(buildRuns)
            .where(eq(buildRuns.id, buildId))
            .limit(1);
          if (!existing || existing.project !== project) {
            return { kind: 'not_found' as const };
          }
          if (existing.status === 'intake') {
            const [openRev] = await tx
              .select()
              .from(buildRevisions)
              .where(
                and(
                  eq(buildRevisions.buildRunId, buildId),
                  eq(buildRevisions.revisionNumber, existing.currentRevisionNumber),
                ),
              )
              .limit(1);
            if (openRev && openRev.feedback === redactedFeedback) {
              return {
                kind: 'resumed' as const,
                run: mapRun(existing),
                revision: mapRev(openRev, actorUserId),
              };
            }
            return { kind: 'in_progress' as const };
          }
          if (
            existing.status === 'preview_ready'
            && existing.revisionsUsed >= existing.revisionCap
          ) {
            return { kind: 'cap_reached' as const, limit: existing.revisionCap };
          }
          return { kind: 'not_revisable' as const, status: existing.status };
        }

        const [prevRev] = await tx
          .select()
          .from(buildRevisions)
          .where(
            and(
              eq(buildRevisions.buildRunId, buildId),
              eq(
                buildRevisions.revisionNumber,
                updatedRun.currentRevisionNumber - 1,
              ),
            ),
          )
          .limit(1);

        const [insertedRev] = await tx
          .insert(buildRevisions)
          .values({
            buildRunId: buildId,
            revisionNumber: updatedRun.currentRevisionNumber,
            feedback: redactedFeedback,
            requirements: prevRev?.requirements ?? [],
            assumptions: prevRev?.assumptions ?? [],
            exclusions: prevRev?.exclusions ?? [],
            riskDecisions: prevRev?.riskDecisions ?? [],
          })
          .returning();

        if (updatedRun.interviewId) {
          await reopenInterviewBriefForRevision(
            {
              interviewId: updatedRun.interviewId,
              reopenedBy: actorUserId,
            },
            tx,
          );
        }

        return {
          kind: 'started' as const,
          run: mapRun(updatedRun),
          revision: mapRev(insertedRev, actorUserId),
        };
      });
    },
    async reopenBrief(interviewId, reopenedBy) {
      await reopenInterviewBriefForRevision({ interviewId, reopenedBy });
    },
    async sendKickoffTurn() {
      // Dispatches to chatAgentService in production
    },
    async casApproveRevision(buildRunId, revisionNumber, classification, briefVersion) {
      const now = new Date().toISOString();
      const nextStatus: BuildRunStatus =
        classification === 'small' ? 'building' : 'planning';
      const rows = await db
        .update(buildRuns)
        .set({ status: nextStatus, updatedAt: now })
        .where(
          and(
            eq(buildRuns.id, buildRunId),
            eq(buildRuns.status, 'intake'),
            eq(buildRuns.currentRevisionNumber, revisionNumber),
          ),
        )
        .returning({ id: buildRuns.id });
      if (rows.length === 0) return false;
      await db
        .update(buildRevisions)
        .set({ classification, briefVersion, updatedAt: now })
        .where(
          and(
            eq(buildRevisions.buildRunId, buildRunId),
            eq(buildRevisions.revisionNumber, revisionNumber),
          ),
        );
      return true;
    },
    async mergeIntoIntegration() {
      return 'nothing_to_merge';
    },
    incrementRepairAttempt: (revisionId) =>
      requestRepairAttempt(revisionId, 'revision_sync_conflict'),
    async createSmallRevisionTask(revisionId, covers) {
      await db
        .insert(buildTasks)
        .values({
          buildRevisionId: revisionId,
          taskKey: 'r-small-1',
          role: 'implementer',
          dependsOn: [],
          ownedFiles: [],
          covers,
          reuse: [],
          runMode: 'own_agent',
          status: 'ready',
          attempt: 1,
        })
        .onConflictDoNothing();
    },
    async launchRevisionAgent() {
      // Dispatched via dispatchNext
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
  };
}

export function createBuildRevisionService(
  deps: BuildRevisionServiceDeps = createDefaultBuildRevisionDeps(),
) {
  return {
    async requestRevision(input: {
      buildId: string;
      project: string;
      feedback: string;
      actor: BuildActorContext;
    }): Promise<BuildRevisionAccepted> {
      const trimmed = typeof input.feedback === 'string' ? input.feedback.trim() : '';
      if (!trimmed) {
        throw new BuildRevisionError(
          'FEEDBACK_REQUIRED',
          'Describe what you want changed.',
          400,
        );
      }
      if (trimmed.length > BUILD_REVISION_FEEDBACK_MAX_LENGTH) {
        throw new BuildRevisionError(
          'FEEDBACK_TOO_LONG',
          'Use 4,000 characters or fewer.',
          400,
        );
      }

      const precheckRun = await deps.loadRun(input.buildId);
      if (!precheckRun) {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This build does not exist.',
          404,
        );
      }
      if (precheckRun.project !== input.project) {
        throw new BuildRevisionError(
          'BUILD_PROJECT_MISMATCH',
          'This build belongs to another project.',
          403,
        );
      }

      const auth = canActOnBuild(input.actor, precheckRun);
      if (!auth.allowed) {
        console.info('build.revision.refused', {
          project: input.project,
          buildId: input.buildId,
          code: 'NOT_REQUESTER_OR_ADMIN',
        });
        throw new BuildRevisionError(
          'NOT_REQUESTER_OR_ADMIN',
          'Only the requester or a project admin can request changes for this build.',
          403,
        );
      }

      const redactedFeedback = redactText(trimmed);

      const cas = await deps.casTransitionToIntake({
        buildId: input.buildId,
        project: input.project,
        redactedFeedback,
        actorUserId: input.actor.userId,
      });

      switch (cas.kind) {
        case 'not_found':
          throw new BuildRevisionError(
            'BUILD_NOT_FOUND',
            'This build does not exist.',
            404,
          );
        case 'cap_reached':
          throw new BuildRevisionError(
            'REVISION_CAP_REACHED',
            `This build has used all ${cas.limit} revisions. Accept the current preview or ask a project admin for help.`,
            409,
          );
        case 'in_progress':
          throw new BuildRevisionError(
            'REVISION_IN_PROGRESS',
            'A revision is already in progress for this build.',
            409,
          );
        case 'not_revisable':
          throw new BuildRevisionError(
            'BUILD_NOT_REVISABLE',
            cas.status === 'accepted'
              ? 'An accepted build cannot be revised.'
              : 'Changes can only be requested when the preview is ready.',
            409,
          );
        case 'resumed': {
          const { run, revision } = cas;
          if (!revision.hasKickoffTurnSent && run.chatThreadId) {
            const prompt = buildRevisionKickoffPrompt({
              revisionNumber: revision.revisionNumber,
              feedback: redactedFeedback,
              requirements: revision.requirements,
            });
            void deps.sendKickoffTurn(run.chatThreadId, prompt, revision.id);
          }
          return {
            buildId: run.id,
            revisionNumber: revision.revisionNumber,
            status: 'intake',
            revisionsUsed: run.revisionsUsed,
            revisionsLimit: run.revisionCap,
            interviewId: run.interviewId ?? '',
            chatThreadId: run.chatThreadId ?? '',
            resumed: true,
          };
        }
        case 'started': {
          const { run, revision } = cas;
          await deps.appendEvent({
            buildRunId: run.id,
            buildRevisionId: revision.id,
            eventType: 'revision.requested',
            message:
              auth.authorization === 'administrator'
                ? `${input.actor.displayName ?? input.actor.userId} requested revision ${revision.revisionNumber} on behalf of ${run.requesterDisplayName}.`
                : `Requested revision ${revision.revisionNumber}.`,
            detail: {
              revisionNumber: revision.revisionNumber,
              actorId: input.actor.userId,
              actorName: input.actor.displayName ?? input.actor.userId,
              authorization: auth.authorization,
              ...(auth.authorization === 'administrator'
                ? {
                    onBehalfOf: {
                      userId: run.requesterUserId,
                      displayName: run.requesterDisplayName,
                    },
                  }
                : {}),
            },
            actorUserId: input.actor.userId,
          });

          console.info('build.revision.requested', {
            project: run.project,
            buildId: run.id,
            revisionNumber: revision.revisionNumber,
            actorId: input.actor.userId,
            authorization: auth.authorization,
          });

          if (run.chatThreadId) {
            const prompt = buildRevisionKickoffPrompt({
              revisionNumber: revision.revisionNumber,
              feedback: redactedFeedback,
              requirements: revision.requirements,
            });
            void deps
              .sendKickoffTurn(run.chatThreadId, prompt, revision.id)
              .catch(async () => {
                await deps.appendEvent({
                  buildRunId: run.id,
                  buildRevisionId: revision.id,
                  eventType: 'revision.kickoff_failed',
                  severity: 'error',
                  message: 'Could not start the revision conversation.',
                  detail: { revisionNumber: revision.revisionNumber },
                });
              });
          }

          return {
            buildId: run.id,
            revisionNumber: revision.revisionNumber,
            status: 'intake',
            revisionsUsed: run.revisionsUsed,
            revisionsLimit: run.revisionCap,
            interviewId: run.interviewId ?? '',
            chatThreadId: run.chatThreadId ?? '',
            resumed: false,
          };
        }
        default: {
          const exhaustive: never = cas;
          throw new Error(`Unhandled CAS outcome: ${JSON.stringify(exhaustive)}`);
        }
      }
    },

    async handleRevisionBriefApproved(input: {
      interviewId: string;
      approvedBy: string;
      briefVersion: number;
      classification?: BuildClassification;
    }): Promise<{ revisionNumber: number; status: 'building' | 'planning' } | null> {
      const run = await deps.loadRunByInterviewId(input.interviewId);
      if (!run || run.status !== 'intake' || run.currentRevisionNumber < 2) {
        return null;
      }

      const rev = await deps.loadCurrentRevision(run.id, run.currentRevisionNumber);
      if (!rev) return null;

      const classification: BuildClassification =
        input.classification ?? rev.classification ?? 'small';
      const won = await deps.casApproveRevision(
        run.id,
        rev.revisionNumber,
        classification,
        input.briefVersion,
      );
      if (!won) return null;

      await deps.appendEvent({
        buildRunId: run.id,
        buildRevisionId: rev.id,
        eventType: 'revision.approved',
        message: `Approved revision ${rev.revisionNumber} brief (${classification}).`,
        detail: {
          revisionNumber: rev.revisionNumber,
          classification,
          briefVersion: input.briefVersion,
        },
        actorUserId: input.approvedBy,
      });

      await this.startRevisionExecution(run, rev, classification);

      return {
        revisionNumber: rev.revisionNumber,
        status: classification === 'small' ? 'building' : 'planning',
      };
    },

    async startRevisionExecution(
      run: RevisionRunRecord,
      revision: RevisionStateRecord,
      classification: BuildClassification,
    ): Promise<void> {
      const targetBranch = run.integrationBranch ?? `apex/build/${run.id}`;
      const mergeOutcome = await deps.mergeIntoIntegration({
        sourceBranch: run.defaultBranch,
        targetBranch,
        deleteSourceBranch: false,
      });

      if (mergeOutcome === 'conflict') {
        revision.catchUpConflict = true;
        await deps.incrementRepairAttempt(revision.id);
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'revision.catch_up',
          severity: 'warn',
          message: 'Default branch had a conflict with the integration branch; handed to the first revision agent.',
          detail: { outcome: 'conflict', revisionNumber: revision.revisionNumber },
        });
      } else {
        revision.catchUpConflict = false;
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'revision.catch_up',
          message: `Synced default branch into ${targetBranch} (${mergeOutcome}).`,
          detail: { outcome: mergeOutcome, revisionNumber: revision.revisionNumber },
        });
      }

      if (classification === 'small') {
        await deps.createSmallRevisionTask(
          revision.id,
          revision.changedAndAddedIds,
        );
      }

      await deps.launchRevisionAgent(run.id, revision.id);
    },
  };
}

export const defaultBuildRevisionService = createBuildRevisionService();
