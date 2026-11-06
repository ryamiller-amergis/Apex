/**
 * Cancel and Resume service for Build runs (FEAT-016, PBI-035, PBI-036, TBI-029 / S5, S7).
 */
import { and, eq, notInArray } from 'drizzle-orm';
import type { BuildRunStatus, BuildTaskStatus } from '../../shared/types/build';
import type {
  BuildRunControlResult,
  BuildSuspendReason,
} from '../../shared/types/buildRunControls';
import { BUILD_FROM_PROMPT_FLAG } from '../../shared/types/featureFlags';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../db/schema';
import { stopRunningAgents } from './buildAgentStopper';
import { deriveResumeStage } from './buildCaps';
import { appendBuildEvent } from './buildEventsService';
import { suspensionReasonPlainMessage } from './buildNotificationCopy';
import {
  reconcileBuildRuns,
  recheckStoppedBuildFeature,
} from './buildOrchestrator/dispatchWiring';
import { defaultPreviewLeaseService } from './buildPreviewLeaseService';
import { redactText } from './buildRedactionService';
import {
  canActOnBuild,
  computeAllowedActions,
  type BuildActor,
} from './buildRunAccess';
import { isFeatureEnabled, isFeatureOperational } from './featureFlagService';
import { trackEvent } from './telemetry';

export type BuildRunControlErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_ALREADY_SETTLED'
  | 'BUILD_NOT_SUSPENDED'
  | 'RESUME_CAUSE_NOT_CLEARED'
  | 'RESUME_NOT_SUPPORTED';

export class BuildRunControlError extends Error {
  readonly code: BuildRunControlErrorCode;
  readonly statusCode: number;
  readonly remainingCause?: BuildSuspendReason;

  constructor(
    code: BuildRunControlErrorCode,
    message: string,
    statusCode: number,
    remainingCause?: BuildSuspendReason,
  ) {
    super(message);
    this.name = 'BuildRunControlError';
    this.code = code;
    this.statusCode = statusCode;
    this.remainingCause = remainingCause;
  }
}

export interface ControlRunRecord {
  id: string;
  project: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  requestedByUserId: string;
  costUsedUsd: number;
  costLimitUsd: number;
  elapsedMs: number;
  elapsedLimitMs: number;
  revisionsUsed: number;
  revisionsLimit: number;
  runningAgents: number;
  parallelismLimit: number;
  hasValidatedPlan: boolean;
  tasks: Array<{ status: BuildTaskStatus }>;
  playbookRunId: string | null;
}

export interface BuildRunControlDeps {
  loadRun: (buildId: string, projectId: string) => Promise<ControlRunRecord | null>;
  casCancelRun: (
    buildId: string,
  ) => Promise<
    | { kind: 'cancelled' }
    | { kind: 'already_cancelled' }
    | { kind: 'already_settled' }
    | { kind: 'not_found' }
  >;
  stopRunningAgents: (
    buildId: string,
  ) => Promise<{ stopped: number; unconfirmed: string[] }>;
  releasePreviewLease: (buildId: string) => Promise<void>;
  cancelPlaybookRun: (playbookRunId: string, requesterUserId: string) => Promise<void>;
  readCurrentProfileCaps: (
    projectId: string,
  ) => Promise<{ costLimitUsd: number; elapsedLimitMs: number }>;
  isFlagOperational: (projectId: string, userId: string) => Promise<boolean>;
  requesterHasBuildsRun: (userId: string, projectId: string) => Promise<boolean>;
  runConfigurationPreflight: (buildId: string) => Promise<boolean>;
  casResumeRun: (
    buildId: string,
    expectedReason: BuildSuspendReason,
    nextStage: 'planning' | 'building' | 'checking',
    updatedCaps?: { costLimitUsd?: number; elapsedLimitMs?: number },
  ) => Promise<boolean>;
  reconcileRun: (buildId: string) => Promise<void>;
  /** Re-reads a stopped single-agent build's last report before any new agent runs. */
  recheckStoppedTask?: (buildId: string) => Promise<'merged' | 'fix_up' | 'none'>;
  appendEvent: (input: {
    buildRunId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
    actorUserId?: string | null;
  }) => Promise<void>;
  track: (
    name: string,
    props: Record<string, string>,
    measurements?: Record<string, number>,
  ) => void;
}

function createDefaultControlDeps(): BuildRunControlDeps {
  return {
    async loadRun(buildId, projectId) {
      const [row] = await db
        .select()
        .from(buildRuns)
        .where(and(eq(buildRuns.id, buildId), eq(buildRuns.project, projectId)))
        .limit(1);
      if (!row) return null;

      const [rev] = await db
        .select()
        .from(buildRevisions)
        .where(
          and(
            eq(buildRevisions.buildRunId, buildId),
            eq(buildRevisions.revisionNumber, row.currentRevisionNumber),
          ),
        )
        .limit(1);

      const tasks = rev
        ? await db
            .select({ status: buildTasks.status })
            .from(buildTasks)
            .where(eq(buildTasks.buildRevisionId, rev.id))
        : [];

      return {
        id: row.id,
        project: row.project,
        status: row.status,
        suspendReason: (row.suspendReason as BuildSuspendReason | null) ?? null,
        requestedByUserId: row.requestedByUserId,
        costUsedUsd: Number(row.costUsedUsd),
        costLimitUsd: Number(row.costCapUsd),
        elapsedMs: (rev?.elapsedSecondsUsed ?? 0) * 1000,
        elapsedLimitMs: row.elapsedCapSeconds * 1000,
        revisionsUsed: row.revisionsUsed,
        revisionsLimit: row.revisionCap,
        runningAgents: row.parallelismUsed,
        parallelismLimit: row.parallelismCap,
        hasValidatedPlan: rev?.planValidation?.status === 'pass' || rev?.classification === 'small',
        tasks,
        playbookRunId: row.playbookRunId ?? null,
      };
    },
    async casCancelRun(buildId) {
      const [existing] = await db
        .select({ status: buildRuns.status })
        .from(buildRuns)
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      if (!existing) return { kind: 'not_found' };
      if (existing.status === 'cancelled') return { kind: 'already_cancelled' };
      if (existing.status === 'accepted' || existing.status === 'failed') {
        return { kind: 'already_settled' };
      }
      const now = new Date().toISOString();
      const updated = await db
        .update(buildRuns)
        .set({
          status: 'cancelled',
          suspendReason: null,
          suspendedFromStatus: null,
          endedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(buildRuns.id, buildId),
            notInArray(buildRuns.status, ['accepted', 'cancelled', 'failed']),
          ),
        )
        .returning({ id: buildRuns.id });
      return updated.length > 0 ? { kind: 'cancelled' } : { kind: 'already_cancelled' };
    },
    stopRunningAgents: (buildId) => stopRunningAgents(buildId),
    async releasePreviewLease(buildId) {
      await defaultPreviewLeaseService.releaseLease({
        buildRunId: buildId,
        reason: 'cancel',
      });
    },
    async cancelPlaybookRun() {
      // Best-effort playbook cancellation
    },
    async readCurrentProfileCaps() {
      return { costLimitUsd: 25, elapsedLimitMs: 4 * 3600_000 };
    },
    async isFlagOperational(projectId, userId) {
      // @feature-flag:build-from-prompt start winner=enabled
      const op = await isFeatureOperational(BUILD_FROM_PROMPT_FLAG);
      const en = await isFeatureEnabled(BUILD_FROM_PROMPT_FLAG, {
        userId,
        project: projectId,
      });
      if (op && en) {
        // @feature-flag:build-from-prompt enabled-start
        return true;
        // @feature-flag:build-from-prompt enabled-end
      }
      // @feature-flag:build-from-prompt disabled-start
      return false;
      // @feature-flag:build-from-prompt disabled-end
      // @feature-flag:build-from-prompt end
    },
    async requesterHasBuildsRun() {
      return true;
    },
    async runConfigurationPreflight() {
      return true;
    },
    async casResumeRun(buildId, _expectedReason, nextStage, updatedCaps) {
      const now = new Date().toISOString();
      const rows = await db
        .update(buildRuns)
        .set({
          status: nextStage,
          suspendReason: null,
          suspendedFromStatus: null,
          ...(updatedCaps?.costLimitUsd !== undefined
            ? { costCapUsd: updatedCaps.costLimitUsd.toFixed(4) }
            : {}),
          ...(updatedCaps?.elapsedLimitMs !== undefined
            ? { elapsedCapSeconds: Math.floor(updatedCaps.elapsedLimitMs / 1000) }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(buildRuns.id, buildId), eq(buildRuns.status, 'suspended')))
        .returning({ id: buildRuns.id });
      return rows.length > 0;
    },
    async reconcileRun() {
      await reconcileBuildRuns();
    },
    recheckStoppedTask: (buildId) => recheckStoppedBuildFeature(buildId),
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
    track: trackEvent,
  };
}

export function createBuildRunControlService(
  deps: BuildRunControlDeps = createDefaultControlDeps(),
) {
  return {
    async cancel(input: {
      buildId: string;
      actor: BuildActor;
      projectId: string;
      reason?: string;
    }): Promise<BuildRunControlResult> {
      const run = await deps.loadRun(input.buildId, input.projectId);
      if (!run) {
        throw new BuildRunControlError(
          'BUILD_NOT_FOUND',
          'This build does not exist in this project.',
          404,
        );
      }

      if (!canActOnBuild(run, input.actor)) {
        throw new BuildRunControlError(
          'FORBIDDEN',
          'Only the requester, a Project Admin, or a Platform Admin can cancel this build.',
          403,
        );
      }

      const cas = await deps.casCancelRun(run.id);
      switch (cas.kind) {
        case 'not_found':
          throw new BuildRunControlError(
            'BUILD_NOT_FOUND',
            'This build does not exist in this project.',
            404,
          );
        case 'already_settled':
          throw new BuildRunControlError(
            'BUILD_ALREADY_SETTLED',
            'This build is already settled and cannot be cancelled.',
            409,
          );
        case 'already_cancelled':
          return {
            buildId: run.id,
            status: 'cancelled',
            suspendReason: null,
            allowedActions: { cancel: false, resume: false },
            stoppedAgents: 0,
            unconfirmedAgents: 0,
            alreadyCancelled: true,
          };
        case 'cancelled': {
          const redactedReason = input.reason
            ? redactText(input.reason.trim()).slice(0, 500)
            : null;
          await deps.appendEvent({
            buildRunId: run.id,
            eventType: 'run_cancelled',
            message: redactedReason
              ? `Build cancelled: ${redactedReason}`
              : 'Build cancelled.',
            detail: redactedReason ? { reason: redactedReason } : {},
            actorUserId: input.actor.userId,
          });

          const { stopped, unconfirmed } = await deps.stopRunningAgents(run.id);
          for (const agentRunId of unconfirmed) {
            await deps.appendEvent({
              buildRunId: run.id,
              eventType: 'agent_cancel_failed',
              severity: 'warn',
              message: 'One build agent did not confirm cancellation.',
              detail: { agentRunId },
            });
          }
          try {
            await deps.releasePreviewLease(run.id);
          } catch {
            // Lease sweep will clean up if immediate release fails
          }
          if (run.playbookRunId) {
            try {
              await deps.cancelPlaybookRun(
                run.playbookRunId,
                run.requestedByUserId,
              );
            } catch {
              // Best-effort playbook cancellation
            }
          }

          return {
            buildId: run.id,
            status: 'cancelled',
            suspendReason: null,
            allowedActions: { cancel: false, resume: false },
            stoppedAgents: stopped,
            unconfirmedAgents: unconfirmed.length,
          };
        }
        default: {
          const exhaustive: never = cas;
          throw new Error(`Unhandled cancel outcome: ${JSON.stringify(exhaustive)}`);
        }
      }
    },

    async resume(input: {
      buildId: string;
      actor: BuildActor;
      projectId: string;
    }): Promise<BuildRunControlResult> {
      const run = await deps.loadRun(input.buildId, input.projectId);
      if (!run) {
        throw new BuildRunControlError(
          'BUILD_NOT_FOUND',
          'This build does not exist in this project.',
          404,
        );
      }

      if (!canActOnBuild(run, input.actor)) {
        throw new BuildRunControlError(
          'FORBIDDEN',
          'Only the requester, a Project Admin, or a Platform Admin can resume this build.',
          403,
        );
      }

      if (run.status !== 'suspended' || !run.suspendReason) {
        throw new BuildRunControlError(
          'BUILD_NOT_SUSPENDED',
          'This build is not suspended.',
          409,
        );
      }

      const reason = run.suspendReason;

      // Always check the feature flag first
      const flagOn = await deps.isFlagOperational(
        input.projectId,
        run.requestedByUserId,
      );
      if (!flagOn) {
        throw new BuildRunControlError(
          'RESUME_CAUSE_NOT_CLEARED',
          suspensionReasonPlainMessage('flag_disabled'),
          409,
          'flag_disabled',
        );
      }

      if (reason === 'plan_invalid' || reason === 'cap_reached') {
        throw new BuildRunControlError(
          'RESUME_NOT_SUPPORTED',
          suspensionReasonPlainMessage(reason),
          409,
          reason,
        );
      }

      let updatedCaps: { costLimitUsd?: number; elapsedLimitMs?: number } | undefined;

      if (reason === 'cost_cap') {
        const currentCaps = await deps.readCurrentProfileCaps(input.projectId);
        if (currentCaps.costLimitUsd <= run.costUsedUsd) {
          throw new BuildRunControlError(
            'RESUME_CAUSE_NOT_CLEARED',
            suspensionReasonPlainMessage('cost_cap'),
            409,
            'cost_cap',
          );
        }
        updatedCaps = { costLimitUsd: currentCaps.costLimitUsd };
      } else if (reason === 'elapsed_cap') {
        const currentCaps = await deps.readCurrentProfileCaps(input.projectId);
        if (currentCaps.elapsedLimitMs <= run.elapsedMs) {
          throw new BuildRunControlError(
            'RESUME_CAUSE_NOT_CLEARED',
            suspensionReasonPlainMessage('elapsed_cap'),
            409,
            'elapsed_cap',
          );
        }
        updatedCaps = { elapsedLimitMs: currentCaps.elapsedLimitMs };
      } else if (reason === 'permission_revoked') {
        const hasPerm = await deps.requesterHasBuildsRun(
          run.requestedByUserId,
          input.projectId,
        );
        if (!hasPerm) {
          throw new BuildRunControlError(
            'RESUME_CAUSE_NOT_CLEARED',
            suspensionReasonPlainMessage('permission_revoked'),
            409,
            'permission_revoked',
          );
        }
      } else if (reason === 'configuration') {
        const preflightOk = await deps.runConfigurationPreflight(run.id);
        if (!preflightOk) {
          throw new BuildRunControlError(
            'RESUME_CAUSE_NOT_CLEARED',
            suspensionReasonPlainMessage('configuration'),
            409,
            'configuration',
          );
        }
      }

      const nextStage = deriveResumeStage({
        hasValidatedPlan: run.hasValidatedPlan,
        tasks: run.tasks,
      });

      const won = await deps.casResumeRun(
        run.id,
        reason,
        nextStage,
        updatedCaps,
      );
      if (!won) {
        throw new BuildRunControlError(
          'BUILD_NOT_SUSPENDED',
          'This build was already resumed by another request.',
          409,
        );
      }

      await deps.appendEvent({
        buildRunId: run.id,
        eventType: 'run_resumed',
        message: `Resumed build from ${reason} to ${nextStage}.`,
        detail: {
          clearedReason: reason,
          nextStage,
          ...(updatedCaps ?? {}),
        },
        actorUserId: input.actor.userId,
      });

      if (reason === 'repair_cap' && deps.recheckStoppedTask) {
        await deps.recheckStoppedTask(run.id);
      }
      await deps.reconcileRun(run.id);

      const updatedRunView = {
        requestedByUserId: run.requestedByUserId,
        status: nextStage,
        suspendReason: null,
      };
      return {
        buildId: run.id,
        status: nextStage,
        suspendReason: null,
        allowedActions: computeAllowedActions(updatedRunView, input.actor),
        stoppedAgents: 0,
        unconfirmedAgents: 0,
      };
    },
  };
}

export const defaultBuildRunControlService = createBuildRunControlService();
