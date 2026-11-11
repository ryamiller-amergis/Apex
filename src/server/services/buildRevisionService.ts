/**
 * Build revision engine service (FEAT-014, TBI-026, PBI-030..032 / S5, S8, S9, S10, S11).
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type {
  BuildClassification,
  BuildRequirement,
  BuildRiskDecision,
  BuildRunStatus,
} from '../../shared/types/build';
import { isApprovedLogoImplementationRequest } from '../../shared/buildLogoReview';
import {
  BUILD_REVISION_FEEDBACK_MAX_LENGTH,
  type BuildRevisionAccepted,
  type BuildRevisionErrorCode,
} from '../../shared/types/buildRevision';
import { db } from '../db/drizzle';
import {
  buildEvents,
  buildLogoCandidates,
  buildRevisions,
  buildRuns,
  buildTasks,
  chatThreads,
  interviews,
} from '../db/schema';
import {
  canActOnBuild,
  type BuildActorContext,
} from './build/buildAccessPolicy';
import { requestRepairAttempt } from './build/repairAttempts';
import { deriveRevisionDelta } from './buildRequirementAmendment';
import { appendBuildEvent } from './buildEventsService';
import { redactText } from './buildRedactionService';
import { buildRevisionKickoffPrompt } from './buildRevisionPrompts';
import { seedRevisionVerificationRows } from './buildRevisionVerificationCarryForward';
import { insertMessage } from './chatThreadRepository';
import { reopenInterviewBriefForRevision } from './interviewBriefService';

/** A warm preview can take a fast UI change while deployment is still finishing or has failed. */
const FAST_REVISION_RUN_STATUSES = [
  'preview_ready',
  'deploying',
  'deployment_failed',
] as const;

/** A change sent while the build is still running waits for its preview, then starts. */
const REVISION_QUEUE_RUN_STATUSES: readonly BuildRunStatus[] = [
  'queued',
  'planning',
  'building',
  'checking',
];

const REVISION_START_FAILED_REPLY =
  'Apex could not start this change. Send it again to retry.';

export class BuildRevisionError extends Error {
  readonly code: BuildRevisionErrorCode;
  readonly statusCode: number;

  constructor(
    code: BuildRevisionErrorCode,
    message: string,
    statusCode: number
  ) {
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
  loadRunByInterviewId: (
    interviewId: string
  ) => Promise<RevisionRunRecord | null>;
  loadCurrentRevision: (
    buildRunId: string,
    revisionNumber: number
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
  appendRevisionFeedback: (
    threadId: string,
    feedback: string,
    messageId: string,
    revisionNumber: number
  ) => Promise<void>;
  appendAssistantReply?: (threadId: string, text: string) => Promise<void>;
  queueRevision?: (input: {
    run: RevisionRunRecord;
    redactedFeedback: string;
    actorUserId: string;
    hasAttachments: boolean;
  }) => Promise<void>;
  sendKickoffTurn: (
    threadId: string,
    prompt: string,
    revisionId: string
  ) => Promise<void>;
  casApproveRevision: (
    buildRunId: string,
    revisionNumber: number,
    classification: BuildClassification,
    briefVersion: number
  ) => Promise<boolean>;
  mergeIntoIntegration: (opts: {
    sourceBranch: string;
    targetBranch: string;
    deleteSourceBranch: boolean;
  }) => Promise<'merged' | 'nothing_to_merge' | 'conflict'>;
  incrementRepairAttempt: (
    revisionId: string
  ) => Promise<{ granted: boolean; used: number }>;
  createSmallRevisionTask: (
    revisionId: string,
    covers: string[]
  ) => Promise<void>;
  launchRevisionAgent: (
    buildRunId: string,
    revisionId: string
  ) => Promise<void>;
  beginEditablePreview?: (input: {
    buildRunId: string;
    draftRevisionId: string;
  }) => Promise<void>;
  requestFastRevision?: (input: {
    run: RevisionRunRecord;
    redactedFeedback: string;
    actorUserId: string;
    approvedLogoCandidateId?: string;
  }) => Promise<BuildRevisionAccepted | null>;
  retryFastEdit?: (input: {
    buildRunId: string;
    attemptId: string;
  }) => Promise<{ kind: string }>;
  rollbackFastEdit?: (input: {
    buildRunId: string;
    attemptId: string;
  }) => Promise<{ kind: string }>;
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
  const mapRun = (
    row: typeof buildRuns.$inferSelect,
    chatThreadId: string | null = null
  ): RevisionRunRecord => ({
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
    chatThreadId,
    integrationBranch: row.integrationBranch ?? `apex/build/${row.id}`,
    defaultBranch: 'main',
  });

  const mapRev = (
    row: typeof buildRevisions.$inferSelect,
    requestedByUserId: string
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
      const [result] = await db
        .select({ run: buildRuns, chatThreadId: interviews.chatThreadId })
        .from(buildRuns)
        .leftJoin(interviews, eq(buildRuns.interviewId, interviews.id))
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      return result ? mapRun(result.run, result.chatThreadId) : null;
    },
    async loadRunByInterviewId(interviewId) {
      const [result] = await db
        .select({ run: buildRuns, chatThreadId: interviews.chatThreadId })
        .from(buildRuns)
        .leftJoin(interviews, eq(buildRuns.interviewId, interviews.id))
        .where(eq(buildRuns.interviewId, interviewId))
        .limit(1);
      return result ? mapRun(result.run, result.chatThreadId) : null;
    },
    async loadCurrentRevision(buildRunId, revisionNumber) {
      const [row] = await db
        .select()
        .from(buildRevisions)
        .where(
          and(
            eq(buildRevisions.buildRunId, buildRunId),
            eq(buildRevisions.revisionNumber, revisionNumber)
          )
        )
        .limit(1);
      if (!row) return null;
      const mapped = mapRev(row, '');
      if (revisionNumber < 2) return mapped;
      const [previous] = await db
        .select()
        .from(buildRevisions)
        .where(
          and(
            eq(buildRevisions.buildRunId, buildRunId),
            eq(buildRevisions.revisionNumber, revisionNumber - 1)
          )
        )
        .limit(1);
      if (!previous) return mapped;
      const delta = deriveRevisionDelta({
        previousRequirements: previous.requirements,
        previousRiskDecisions: previous.riskDecisions,
        nextRequirements: row.requirements,
        nextRiskDecisions: row.riskDecisions,
      });
      mapped.changedAndAddedIds = [...delta.changedIds, ...delta.addedIds];
      return mapped;
    },
    async casTransitionToIntake({
      buildId,
      project,
      redactedFeedback,
      actorUserId,
    }) {
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
              inArray(buildRuns.status, [...FAST_REVISION_RUN_STATUSES]),
              lt(buildRuns.revisionsUsed, buildRuns.revisionCap)
            )
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
                  eq(
                    buildRevisions.revisionNumber,
                    existing.currentRevisionNumber
                  )
                )
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
            (FAST_REVISION_RUN_STATUSES as readonly string[]).includes(
              existing.status
            ) &&
            existing.revisionsUsed >= existing.revisionCap
          ) {
            return {
              kind: 'cap_reached' as const,
              limit: existing.revisionCap,
            };
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
                updatedRun.currentRevisionNumber - 1
              )
            )
          )
          .limit(1);

        const [insertedRev] = await tx
          .insert(buildRevisions)
          .values({
            buildRunId: buildId,
            revisionNumber: updatedRun.currentRevisionNumber,
            feedback: redactedFeedback,
            briefVersion: prevRev?.briefVersion ?? null,
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
            tx
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
    async appendRevisionFeedback(
      threadId,
      feedback,
      messageId,
      revisionNumber
    ) {
      const ts = new Date().toISOString();
      await insertMessage(threadId, {
        id: messageId,
        role: 'user',
        text: feedback,
        ts,
      });
      await db
        .update(chatThreads)
        .set({ lastActivityAt: ts })
        .where(eq(chatThreads.id, threadId));
      console.info('build.revision.chat_turn_appended', {
        threadId,
        revisionNumber,
      });
    },
    async appendAssistantReply(threadId, text) {
      const ts = new Date().toISOString();
      await insertMessage(threadId, {
        id: randomUUID(),
        role: 'agent',
        text,
        ts,
      });
      await db
        .update(chatThreads)
        .set({ lastActivityAt: ts })
        .where(eq(chatThreads.id, threadId));
    },
    async queueRevision({ run, redactedFeedback, actorUserId, hasAttachments }) {
      await appendBuildEvent({
        buildRunId: run.id,
        eventType: 'revision.queued',
        message: 'Saved a change to start when the current preview is ready.',
        detail: { feedback: redactedFeedback, actorId: actorUserId, hasAttachments },
        actorUserId,
        dedupeKey: `revision-queued:${run.id}:${run.currentRevisionNumber}:${createHash('sha256').update(redactedFeedback).digest('hex').slice(0, 16)}`,
      });
    },
    async sendKickoffTurn(threadId, prompt) {
      const { sendMessage } = await import('./chatAgentService');
      await sendMessage(threadId, prompt, undefined, undefined, {
        hidden: true,
        legacyCompletion: 'detach',
      });
    },
    async casApproveRevision(
      buildRunId,
      revisionNumber,
      classification,
      briefVersion
    ) {
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
            eq(buildRuns.currentRevisionNumber, revisionNumber)
          )
        )
        .returning({ id: buildRuns.id });
      if (rows.length === 0) return false;
      await db
        .update(buildRevisions)
        .set({ classification, briefVersion, updatedAt: now })
        .where(
          and(
            eq(buildRevisions.buildRunId, buildRunId),
            eq(buildRevisions.revisionNumber, revisionNumber)
          )
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
    async launchRevisionAgent(buildRunId) {
      const { dispatchNext } =
        await import('./buildOrchestrator/dispatchWiring');
      await dispatchNext(buildRunId);
    },
    async beginEditablePreview(input) {
      const { defaultBuildEditablePreviewSessionService } =
        await import('./build/buildEditablePreviewLocalService');
      await defaultBuildEditablePreviewSessionService.beginRevision(input);
    },
    async requestFastRevision({
      run,
      redactedFeedback,
      actorUserId,
      approvedLogoCandidateId,
    }) {
      const outcome = await db.transaction(async (tx) => {
        if (approvedLogoCandidateId) {
          const [approvedLogo] = await tx
            .select({ id: buildLogoCandidates.id })
            .from(buildLogoCandidates)
            .where(
              and(
                eq(buildLogoCandidates.id, approvedLogoCandidateId),
                eq(buildLogoCandidates.buildRunId, run.id),
                eq(buildLogoCandidates.status, 'approved')
              )
            )
            .limit(1);
          if (!approvedLogo) {
            throw new BuildRevisionError(
              'APPROVED_LOGO_REQUIRED',
              'Approve a logo option before adding it to the build.',
              409
            );
          }
        }
        const now = new Date().toISOString();
        const [updatedRun] = await tx
          .update(buildRuns)
          .set({
            status: 'building',
            revisionsUsed: sql`${buildRuns.revisionsUsed} + 1`,
            currentRevisionNumber: sql`${buildRuns.currentRevisionNumber} + 1`,
            updatedAt: now,
          })
          .where(
            and(
              eq(buildRuns.id, run.id),
              eq(buildRuns.project, run.project),
              inArray(buildRuns.status, [...FAST_REVISION_RUN_STATUSES]),
              lt(buildRuns.revisionsUsed, buildRuns.revisionCap)
            )
          )
          .returning();
        if (!updatedRun) {
          const [existingRun] = await tx
            .select()
            .from(buildRuns)
            .where(eq(buildRuns.id, run.id))
            .limit(1);
          if (!existingRun || existingRun.status !== 'building') return null;
          const [existingRevision] = await tx
            .select()
            .from(buildRevisions)
            .where(
              and(
                eq(buildRevisions.buildRunId, run.id),
                eq(
                  buildRevisions.revisionNumber,
                  existingRun.currentRevisionNumber
                ),
                eq(buildRevisions.feedback, redactedFeedback),
                approvedLogoCandidateId
                  ? eq(
                      buildRevisions.approvedLogoCandidateId,
                      approvedLogoCandidateId
                    )
                  : sql`${buildRevisions.approvedLogoCandidateId} IS NULL`
              )
            )
            .limit(1);
          return existingRevision
            ? {
                run: mapRun(existingRun),
                revision: mapRev(existingRevision, actorUserId),
                resumed: true,
              }
            : null;
        }

        const [previous] = await tx
          .select()
          .from(buildRevisions)
          .where(
            and(
              eq(buildRevisions.buildRunId, run.id),
              eq(
                buildRevisions.revisionNumber,
                updatedRun.currentRevisionNumber - 1
              )
            )
          )
          .limit(1);
        if (!previous?.validatedCommit) {
          throw new Error('Fast revision requires a validated base revision.');
        }
        const [revision] = await tx
          .insert(buildRevisions)
          .values({
            buildRunId: run.id,
            revisionNumber: updatedRun.currentRevisionNumber,
            feedback: redactedFeedback,
            approvedLogoCandidateId: approvedLogoCandidateId ?? null,
            briefVersion: previous.briefVersion,
            requirements: previous.requirements,
            assumptions: previous.assumptions,
            exclusions: previous.exclusions,
            riskDecisions: previous.riskDecisions,
            classification: 'small',
            previewRolloutMode: previous.previewRolloutMode,
            previewUrl: previous.previewUrl,
          })
          .returning();
        await seedRevisionVerificationRows(tx, {
          previousRevisionId: previous.id,
          previousRevisionNumber: previous.revisionNumber,
          nextRevisionId: revision.id,
          previousRequirements: previous.requirements,
          previousRiskDecisions: previous.riskDecisions,
          nextRequirements: revision.requirements,
          nextRiskDecisions: revision.riskDecisions,
        });
        return {
          run: mapRun(updatedRun),
          revision: mapRev(revision, actorUserId),
          resumed: false,
        };
      });
      if (!outcome) return null;

      if (!outcome.resumed) {
        await appendBuildEvent({
          buildRunId: outcome.run.id,
          buildRevisionId: outcome.revision.id,
          eventType: 'revision.fast_edit_requested',
          message: `Started fast revision ${outcome.revision.revisionNumber}.`,
          detail: {
            revisionNumber: outcome.revision.revisionNumber,
            actorId: actorUserId,
          },
          actorUserId,
        });
      }
      const { defaultBuildRevisionFastEditService } =
        await import('./build/buildRevisionFastEditLocalService');
      void defaultBuildRevisionFastEditService.execute({
        buildRunId: outcome.run.id,
        buildRevisionId: outcome.revision.id,
      });
      return {
        buildId: outcome.run.id,
        revisionNumber: outcome.revision.revisionNumber,
        status: 'building',
        revisionsUsed: outcome.run.revisionsUsed,
        revisionsLimit: outcome.run.revisionCap,
        interviewId: outcome.run.interviewId ?? '',
        chatThreadId: outcome.run.chatThreadId ?? '',
        resumed: outcome.resumed,
      };
    },
    async retryFastEdit(input) {
      const { defaultBuildRevisionFastEditService } =
        await import('./build/buildRevisionFastEditLocalService');
      return defaultBuildRevisionFastEditService.startRetry(input);
    },
    async rollbackFastEdit(input) {
      const { defaultBuildRevisionFastEditService } =
        await import('./build/buildRevisionFastEditLocalService');
      return defaultBuildRevisionFastEditService.startRollback(input);
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
  };
}

export function createBuildRevisionService(
  deps: BuildRevisionServiceDeps = createDefaultBuildRevisionDeps()
) {
  return {
    async requestRevision(input: {
      buildId: string;
      project: string;
      feedback: string;
      hasAttachments?: boolean;
      approvedLogoCandidateId?: string;
      actor: BuildActorContext;
      /** The requester's words are already in the chat (a queued change starting later). */
      chatMessageSaved?: boolean;
    }): Promise<BuildRevisionAccepted> {
      const trimmed =
        typeof input.feedback === 'string' ? input.feedback.trim() : '';
      if (!trimmed) {
        throw new BuildRevisionError(
          'FEEDBACK_REQUIRED',
          'Describe what you want changed.',
          400
        );
      }
      if (trimmed.length > BUILD_REVISION_FEEDBACK_MAX_LENGTH) {
        throw new BuildRevisionError(
          'FEEDBACK_TOO_LONG',
          'Use 4,000 characters or fewer.',
          400
        );
      }

      const precheckRun = await deps.loadRun(input.buildId);
      if (!precheckRun) {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This build does not exist.',
          404
        );
      }
      if (precheckRun.project !== input.project) {
        throw new BuildRevisionError(
          'BUILD_PROJECT_MISMATCH',
          'This build belongs to another project.',
          403
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
          403
        );
      }

      const redactedFeedback = redactText(trimmed);
      const threadId = precheckRun.chatThreadId;
      // Attachments travel with the client's own chat turn.
      const repliesInChat = Boolean(threadId) && !input.hasAttachments;
      if (repliesInChat && !input.chatMessageSaved && threadId) {
        await deps.appendRevisionFeedback(
          threadId,
          redactedFeedback,
          randomUUID(),
          precheckRun.currentRevisionNumber + 1
        );
      }

      try {
        return await this.routeRevision({
          input,
          precheckRun,
          redactedFeedback,
          authorization: auth.authorization,
        });
      } catch (error) {
        if (repliesInChat && threadId && deps.appendAssistantReply) {
          await deps
            .appendAssistantReply(
              threadId,
              error instanceof BuildRevisionError
                ? error.message
                : REVISION_START_FAILED_REPLY
            )
            .catch(() => undefined);
        }
        throw error;
      }
    },

    async routeRevision({
      input,
      precheckRun,
      redactedFeedback,
      authorization,
    }: {
      input: {
        buildId: string;
        project: string;
        hasAttachments?: boolean;
        approvedLogoCandidateId?: string;
        actor: BuildActorContext;
      };
      precheckRun: RevisionRunRecord;
      redactedFeedback: string;
      authorization: 'requester' | 'administrator';
    }): Promise<BuildRevisionAccepted> {
      const auth = { authorization };
      if (
        isApprovedLogoImplementationRequest(redactedFeedback) &&
        !input.approvedLogoCandidateId
      ) {
        throw new BuildRevisionError(
          'APPROVED_LOGO_REQUIRED',
          'Approve a logo option before adding it to the build.',
          409
        );
      }

      if (
        deps.queueRevision &&
        REVISION_QUEUE_RUN_STATUSES.includes(precheckRun.status)
      ) {
        if (precheckRun.revisionsUsed >= precheckRun.revisionCap) {
          throw new BuildRevisionError(
            'REVISION_CAP_REACHED',
            `This build has used all ${precheckRun.revisionCap} revisions. Accept the current preview or ask a project admin for help.`,
            409
          );
        }
        await deps.queueRevision({
          run: precheckRun,
          redactedFeedback,
          actorUserId: input.actor.userId,
          hasAttachments: input.hasAttachments === true,
        });
        const nextNumber = precheckRun.currentRevisionNumber + 1;
        if (precheckRun.chatThreadId && !input.hasAttachments) {
          await deps.appendAssistantReply?.(
            precheckRun.chatThreadId,
            `Got it. The build is still running, so this change will start as revision ${nextNumber} as soon as the preview is ready. You don't need to send it again.`
          );
        }
        return {
          buildId: precheckRun.id,
          revisionNumber: nextNumber,
          status: 'queued',
          revisionsUsed: precheckRun.revisionsUsed,
          revisionsLimit: precheckRun.revisionCap,
          interviewId: precheckRun.interviewId ?? '',
          chatThreadId: precheckRun.chatThreadId ?? '',
          resumed: false,
        };
      }

      if (deps.requestFastRevision) {
        const fastRevision = await deps.requestFastRevision({
          run: precheckRun,
          redactedFeedback,
          actorUserId: input.actor.userId,
          approvedLogoCandidateId: input.approvedLogoCandidateId,
        });
        if (fastRevision) {
          if (
            precheckRun.chatThreadId &&
            !input.hasAttachments &&
            !fastRevision.resumed
          ) {
            await deps.appendAssistantReply?.(
              precheckRun.chatThreadId,
              `Working on revision ${fastRevision.revisionNumber} now. The preview will update when the change is ready.`
            );
          }
          return fastRevision;
        }
      }

      const cas = await deps.casTransitionToIntake({
        buildId: input.buildId,
        project: input.project,
        redactedFeedback,
        actorUserId: input.actor.userId,
      });

      const beginEditablePreview = (
        run: RevisionRunRecord,
        revision: RevisionStateRecord
      ): void => {
        if (!deps.beginEditablePreview) return;
        void deps
          .beginEditablePreview({
            buildRunId: run.id,
            draftRevisionId: revision.id,
          })
          .catch(async (error) => {
            await deps.appendEvent({
              buildRunId: run.id,
              buildRevisionId: revision.id,
              eventType: 'studio.start_failed',
              severity: 'warn',
              message: 'The editable preview could not be started.',
              detail: {
                reason:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : String(error).slice(0, 500),
              },
            });
          });
      };

      switch (cas.kind) {
        case 'not_found':
          throw new BuildRevisionError(
            'BUILD_NOT_FOUND',
            'This build does not exist.',
            404
          );
        case 'cap_reached':
          throw new BuildRevisionError(
            'REVISION_CAP_REACHED',
            `This build has used all ${cas.limit} revisions. Accept the current preview or ask a project admin for help.`,
            409
          );
        case 'in_progress':
          throw new BuildRevisionError(
            'REVISION_IN_PROGRESS',
            'A revision is already in progress for this build.',
            409
          );
        case 'not_revisable':
          throw new BuildRevisionError(
            'BUILD_NOT_REVISABLE',
            cas.status === 'accepted'
              ? 'An accepted build cannot be revised.'
              : 'Changes can only be requested when the preview is ready.',
            409
          );
        case 'resumed': {
          const revision = cas.revision;
          const run = {
            ...cas.run,
            chatThreadId: cas.run.chatThreadId ?? precheckRun.chatThreadId,
          };
          beginEditablePreview(run, revision);
          if (
            !input.hasAttachments &&
            !revision.hasKickoffTurnSent &&
            run.chatThreadId
          ) {
            const prompt = buildRevisionKickoffPrompt({
              revisionNumber: revision.revisionNumber,
              feedback: redactedFeedback,
              requirements: revision.requirements,
            });
            await deps.sendKickoffTurn(run.chatThreadId, prompt, revision.id);
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
          const revision = cas.revision;
          const run = {
            ...cas.run,
            chatThreadId: cas.run.chatThreadId ?? precheckRun.chatThreadId,
          };
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

          beginEditablePreview(run, revision);

          if (!input.hasAttachments && run.chatThreadId) {
            const prompt = buildRevisionKickoffPrompt({
              revisionNumber: revision.revisionNumber,
              feedback: redactedFeedback,
              requirements: revision.requirements,
            });
            await deps
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
                throw new BuildRevisionError(
                  'REVISION_IN_PROGRESS',
                  'The revision was saved, but its conversation did not start. Send the same request again to retry.',
                  503
                );
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
          throw new Error(
            `Unhandled CAS outcome: ${JSON.stringify(exhaustive)}`
          );
        }
      }
    },

    async retryFastEdit(input: {
      buildId: string;
      project: string;
      attemptId: string;
      actor: BuildActorContext;
    }): Promise<{ kind: string }> {
      const run = await deps.loadRun(input.buildId);
      if (!run) {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This build does not exist.',
          404
        );
      }
      if (run.project !== input.project) {
        throw new BuildRevisionError(
          'BUILD_PROJECT_MISMATCH',
          'This build belongs to another project.',
          403
        );
      }
      if (!canActOnBuild(input.actor, run).allowed) {
        throw new BuildRevisionError(
          'NOT_REQUESTER_OR_ADMIN',
          'Only the requester or a project admin can retry this revision.',
          403
        );
      }
      const result = await deps.retryFastEdit?.({
        buildRunId: run.id,
        attemptId: input.attemptId,
      });
      if (!result || result.kind === 'not_found') {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This revision update does not exist.',
          404
        );
      }
      return result;
    },

    async rollbackFastEdit(input: {
      buildId: string;
      project: string;
      attemptId: string;
      actor: BuildActorContext;
    }): Promise<{ kind: string }> {
      const run = await deps.loadRun(input.buildId);
      if (!run) {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This build does not exist.',
          404
        );
      }
      if (run.project !== input.project) {
        throw new BuildRevisionError(
          'BUILD_PROJECT_MISMATCH',
          'This build belongs to another project.',
          403
        );
      }
      if (!canActOnBuild(input.actor, run).allowed) {
        throw new BuildRevisionError(
          'NOT_REQUESTER_OR_ADMIN',
          'Only the requester or a project admin can roll back this revision.',
          403
        );
      }
      const result = await deps.rollbackFastEdit?.({
        buildRunId: run.id,
        attemptId: input.attemptId,
      });
      if (!result || result.kind === 'not_found') {
        throw new BuildRevisionError(
          'BUILD_NOT_FOUND',
          'This revision update does not exist.',
          404
        );
      }
      return result;
    },

    async handleRevisionBriefApproved(input: {
      interviewId: string;
      approvedBy: string;
      briefVersion: number;
      classification?: BuildClassification;
    }): Promise<{
      revisionNumber: number;
      status: 'building' | 'planning';
    } | null> {
      const run = await deps.loadRunByInterviewId(input.interviewId);
      if (!run || run.status !== 'intake' || run.currentRevisionNumber < 2) {
        return null;
      }

      const rev = await deps.loadCurrentRevision(
        run.id,
        run.currentRevisionNumber
      );
      if (!rev) return null;

      const classification: BuildClassification =
        input.classification ?? rev.classification ?? 'small';
      const won = await deps.casApproveRevision(
        run.id,
        rev.revisionNumber,
        classification,
        input.briefVersion
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
      classification: BuildClassification
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
          message:
            'Default branch had a conflict with the integration branch; handed to the first revision agent.',
          detail: {
            outcome: 'conflict',
            revisionNumber: revision.revisionNumber,
          },
        });
      } else {
        revision.catchUpConflict = false;
        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'revision.catch_up',
          message: `Synced default branch into ${targetBranch} (${mergeOutcome}).`,
          detail: {
            outcome: mergeOutcome,
            revisionNumber: revision.revisionNumber,
          },
        });
      }

      if (classification === 'small') {
        await deps.createSmallRevisionTask(
          revision.id,
          revision.changedAndAddedIds
        );
      }

      await deps.launchRevisionAgent(run.id, revision.id);
    },
  };
}

export const defaultBuildRevisionService = createBuildRevisionService();

/**
 * Starts changes that were sent while their build was still running. All
 * changes waiting on one build start together as a single revision.
 */
export async function startQueuedRevisions(
  service: Pick<
    ReturnType<typeof createBuildRevisionService>,
    'requestRevision'
  > = defaultBuildRevisionService
): Promise<void> {
  const pending = await db
    .select({
      id: buildEvents.id,
      buildRunId: buildEvents.buildRunId,
      detail: buildEvents.detail,
      runStatus: buildRuns.status,
      project: buildRuns.project,
    })
    .from(buildEvents)
    .innerJoin(buildRuns, eq(buildRuns.id, buildEvents.buildRunId))
    .where(
      and(
        eq(buildEvents.eventType, 'revision.queued'),
        sql`NOT EXISTS (
          SELECT 1 FROM build_events started
          WHERE started.build_run_id = ${buildEvents.buildRunId}
            AND started.dedupe_key = 'revision-queue-started:' || ${buildEvents.id}::text
        )`
      )
    )
    .orderBy(asc(buildEvents.ordinal))
    .limit(50);

  const byRun = new Map<string, typeof pending>();
  for (const row of pending) {
    byRun.set(row.buildRunId, [...(byRun.get(row.buildRunId) ?? []), row]);
  }

  for (const [buildRunId, rows] of byRun) {
    const status = rows[0].runStatus;
    const finished = ['accepted', 'cancelled', 'failed'].includes(status);
    const ready = (FAST_REVISION_RUN_STATUSES as readonly string[]).includes(
      status
    );
    if (!ready && !finished) continue;

    const items = rows.map((row) => {
      const detail = (row.detail ?? {}) as {
        feedback?: unknown;
        actorId?: unknown;
      };
      return {
        id: row.id,
        feedback: typeof detail.feedback === 'string' ? detail.feedback : '',
        actorId: typeof detail.actorId === 'string' ? detail.actorId : '',
      };
    });
    const markStarted = async (message: string): Promise<void> => {
      for (const item of items) {
        await appendBuildEvent({
          buildRunId,
          eventType: 'revision.queue_started',
          message,
          dedupeKey: `revision-queue-started:${item.id}`,
        });
      }
    };
    if (finished) {
      await markStarted('A waiting change was dropped because the build ended.');
      continue;
    }

    const texts = items.map((item) => item.feedback).filter(Boolean);
    const feedback = (
      texts.length > 1 ? texts.map((text) => `- ${text}`).join('\n') : texts[0] ?? ''
    ).slice(0, BUILD_REVISION_FEEDBACK_MAX_LENGTH);
    const actorId = items[items.length - 1].actorId;
    // Mark first so a failing start is reported once instead of on every sweep.
    await markStarted('Started a change that was waiting for the preview.');
    if (!feedback || !actorId) continue;
    try {
      await service.requestRevision({
        buildId: buildRunId,
        project: rows[0].project,
        feedback,
        actor: { userId: actorId, isProjectAdmin: false, isSuperAdmin: true },
        chatMessageSaved: true,
      });
    } catch (error) {
      console.warn('[build-revision] queued change did not start', {
        buildRunId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
