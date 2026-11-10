import type {
  BuildRevisionFastEditCheckSummary,
  BuildRevisionFastEditRoute,
} from '../../../shared/types/buildRevision';
import type {
  BeginEditablePreviewRevisionResult,
  ApplyEditablePreviewDraftResult,
  RunEditablePreviewDraftChecksResult,
} from './buildEditablePreviewSessionService';
import type {
  BuildRevisionFastEditAttempt,
  BuildRevisionFastEditRecoveryPlan,
  FastEditArtifactPointer,
} from './buildRevisionFastEditContracts';
import type { BuildRevisionFastEditClassification } from './buildRevisionFastEditClassifier';
import type { RevisionEditAgentProvider } from './buildRevisionEditAgent';
import type {
  BuildRevisionFastEditArtifactStore,
  MaterializedBuildRevisionFastEditArtifact,
} from './buildRevisionFastEditArtifactStore';
import type {
  AppendBuildRevisionFastEditChangeSetResult,
  BeginBuildRevisionFastEditAttemptInput,
  BeginBuildRevisionFastEditAttemptResult,
  TransitionBuildRevisionFastEditAttemptInput,
  TransitionBuildRevisionFastEditAttemptResult,
} from './buildRevisionFastEditRepository';

export interface BuildRevisionFastEditTarget extends BeginBuildRevisionFastEditAttemptInput {
  revisionNumber: number;
  feedback: string;
  project: string;
  repository: string;
  integrationBranch: string;
  approvedLogoCandidateId?: string | null;
}

interface FastEditRepository {
  beginAttempt(
    input: BeginBuildRevisionFastEditAttemptInput
  ): Promise<BeginBuildRevisionFastEditAttemptResult>;
  transitionAttempt(
    input: TransitionBuildRevisionFastEditAttemptInput
  ): Promise<TransitionBuildRevisionFastEditAttemptResult>;
  appendChangeSet(input: {
    attemptId: string;
    idempotencyKey: string;
    kind: 'edit' | 'rollback';
    artifact: FastEditArtifactPointer;
    expectedWorkspaceVersion: number;
    appliedWorkspaceVersion: number;
  }): Promise<AppendBuildRevisionFastEditChangeSetResult>;
  loadRecoveryPlan(
    attemptId: string
  ): Promise<BuildRevisionFastEditRecoveryPlan | null>;
}

export interface BuildRevisionFastEditServiceDependencies {
  repository: FastEditRepository;
  loadTarget(input: {
    buildRunId: string;
    buildRevisionId: string;
  }): Promise<BuildRevisionFastEditTarget | null>;
  classify(feedback: string): BuildRevisionFastEditClassification;
  beginStudio(input: {
    buildRunId: string;
    draftRevisionId: string;
  }): Promise<BeginEditablePreviewRevisionResult>;
  prepareWorkspace(target: BuildRevisionFastEditTarget): Promise<{
    workspacePath: string;
    release(): Promise<void>;
  }>;
  restoreWorkspace?(input: {
    workspacePath: string;
    recovery: BuildRevisionFastEditRecoveryPlan;
  }): Promise<void>;
  materializeRollback?(input: {
    target: BuildRevisionFastEditTarget;
    workspacePath: string;
    recovery: BuildRevisionFastEditRecoveryPlan;
  }): Promise<MaterializedBuildRevisionFastEditArtifact>;
  editAgent: RevisionEditAgentProvider;
  stageApprovedAssets?(input: {
    target: BuildRevisionFastEditTarget;
    workspacePath: string;
  }): Promise<void>;
  artifactStore: BuildRevisionFastEditArtifactStore;
  applyDraft(input: {
    buildRunId: string;
    draftRevisionId: string;
    expectedWorkspaceVersion: number;
    changeSet: { digest: string; contentRef: string };
  }): Promise<ApplyEditablePreviewDraftResult>;
  runChecks(input: {
    buildRunId: string;
    draftRevisionId: string;
    workspaceVersion: number;
  }): Promise<RunEditablePreviewDraftChecksResult>;
  checkpoint(input: {
    target: BuildRevisionFastEditTarget;
    workspacePath: string;
    artifact: MaterializedBuildRevisionFastEditArtifact;
  }): Promise<string>;
  markValidated(
    revisionId: string,
    commit: string,
    options: { skipEditablePreviewApply: true, deferDeployment: true }
  ): Promise<void>;
  markChecksFailed(input: {
    target: BuildRevisionFastEditTarget;
    summary: BuildRevisionFastEditCheckSummary;
    previewUrl: string;
  }): Promise<void>;
  markExecutionFailed(input: {
    target: BuildRevisionFastEditTarget;
    reason: string;
  }): Promise<void>;
  markRetryStarted?(input: {
    buildRunId: string;
    buildRevisionId: string;
  }): Promise<void>;
  escalate(input: {
    target: BuildRevisionFastEditTarget;
    reason: string;
  }): Promise<void>;
  /** When set, a fast edit that cannot finish locally continues on the cloud agent instead of stopping. */
  handOffToCloud?(input: {
    target: BuildRevisionFastEditTarget;
    reason: string;
  }): Promise<void>;
  now?(): Date;
}

export type BuildRevisionFastEditExecutionResult =
  | { kind: 'not_found' }
  | { kind: 'already_running'; attemptId: string }
  | { kind: 'escalated'; attemptId: string; reason: string }
  | {
      kind: 'checks_failed';
      attemptId: string;
      previewUrl: string;
      workspaceVersion: number;
      summary: BuildRevisionFastEditCheckSummary;
    }
  | {
      kind: 'ready';
      attemptId: string;
      previewUrl: string;
      workspaceVersion: number;
      validatedCommit: string;
    }
  | { kind: 'failed'; attemptId: string; reason: string };

const CHECKS_FAILED = 'checks_failed';
const CHECKS_UNAVAILABLE = 'checks_unavailable';
const MAX_AUTO_REPAIR_ROUNDS = 1;
const MAX_REPAIR_CONTEXT_CHARS = 4_000;

function describeCheckFailures(
  summary: BuildRevisionFastEditCheckSummary | null
): string | undefined {
  const failures = (summary?.tasks ?? [])
    .filter((task) => task.status === 'failed')
    .map((task) => `${task.name}: ${task.message?.trim() || 'failed'}`);
  return failures.length > 0
    ? failures.join('\n\n').slice(0, MAX_REPAIR_CONTEXT_CHARS)
    : undefined;
}

function requireAttempt(
  result: BeginBuildRevisionFastEditAttemptResult
): BuildRevisionFastEditAttempt | null {
  return result.status === 'active_conflict' ? null : result.attempt;
}

async function transition(
  repository: FastEditRepository,
  attempt: BuildRevisionFastEditAttempt,
  input: Omit<
    TransitionBuildRevisionFastEditAttemptInput,
    'attemptId' | 'expectedRecordVersion'
  >
): Promise<BuildRevisionFastEditAttempt> {
  const result = await repository.transitionAttempt({
    attemptId: attempt.id,
    expectedRecordVersion: attempt.recordVersion,
    ...input,
  });
  if (result.status !== 'updated') {
    throw new Error(`Fast-edit transition failed: ${result.status}.`);
  }
  return result.attempt;
}

function studioFailureReason(
  result:
    | BeginEditablePreviewRevisionResult
    | ApplyEditablePreviewDraftResult
    | RunEditablePreviewDraftChecksResult
): string {
  if (result.kind === 'failed') return result.reason;
  return `Studio returned ${result.kind}.`;
}

export function createBuildRevisionFastEditService(
  dependencies: BuildRevisionFastEditServiceDependencies
) {
  const now = dependencies.now ?? (() => new Date());
  const stopExecution = (input: {
    target: BuildRevisionFastEditTarget;
    reason: string;
  }): Promise<void> =>
    dependencies.handOffToCloud
      ? dependencies.handOffToCloud(input)
      : dependencies.markExecutionFailed(input);

  const service = {
    async execute(input: {
      buildRunId: string;
      buildRevisionId: string;
    }): Promise<BuildRevisionFastEditExecutionResult> {
      const target = await dependencies.loadTarget(input);
      if (!target) return { kind: 'not_found' };
      const classification = dependencies.classify(target.feedback);

      if (classification.route === 'full_build') {
        const started = await dependencies.repository.beginAttempt(target);
        if (started.status === 'active_conflict') {
          return {
            kind: 'already_running',
            attemptId: started.activeAttemptId,
          };
        }
        let attempt = started.attempt;
        attempt = await transition(dependencies.repository, attempt, {
          to: 'escalate',
          route: 'full_build',
        });
        await dependencies.escalate({
          target,
          reason:
            classification.reason === 'uncertain_scope'
              ? 'The revision scope was uncertain.'
              : 'The revision requires structural application changes.',
        });
        return {
          kind: 'escalated',
          attemptId: attempt.id,
          reason: classification.reason,
        };
      }

      const studio = await dependencies.beginStudio({
        buildRunId: target.buildRunId,
        draftRevisionId: target.buildRevisionId,
      });
      if (studio.kind !== 'ready') {
        const reason = studioFailureReason(studio);
        await stopExecution({ target, reason });
        return {
          kind: 'failed',
          attemptId: target.buildRevisionId,
          reason,
        };
      }
      const started = await dependencies.repository.beginAttempt({
        ...target,
        expectedWorkspaceVersion: studio.workspaceVersion,
      });
      if (started.status === 'active_conflict') {
        return {
          kind: 'already_running',
          attemptId: started.activeAttemptId,
        };
      }

      let attempt = requireAttempt(started) as BuildRevisionFastEditAttempt;
      const previousFailure =
        started.status === 'existing'
          ? { code: attempt.failureCode, summary: attempt.checkSummary }
          : null;
      let draftRecorded = false;
      let prepared: Awaited<
        ReturnType<BuildRevisionFastEditServiceDependencies['prepareWorkspace']>
      > | null = null;
      try {
        attempt = await transition(dependencies.repository, attempt, {
          to: 'edit',
          route: 'fast_edit' satisfies BuildRevisionFastEditRoute,
        });
        prepared = await dependencies.prepareWorkspace(target);
        let recoveredDraft = false;
        if (started.status === 'existing' && dependencies.restoreWorkspace) {
          const recovery = await dependencies.repository.loadRecoveryPlan(
            attempt.id
          );
          if (recovery && recovery.orderedChangeSets.length > 0) {
            await dependencies.restoreWorkspace({
              workspacePath: prepared.workspacePath,
              recovery,
            });
            recoveredDraft = true;
          }
        }
        // Infrastructure failures after the draft was recorded rerun checks
        // against the same artifact. Code failures send the check output
        // back to the agent so it repairs the existing draft.
        let runAgent = !(
          recoveredDraft && previousFailure?.code === CHECKS_UNAVAILABLE
        );
        let repairContext =
          recoveredDraft && previousFailure?.code === CHECKS_FAILED
            ? describeCheckFailures(previousFailure.summary)
            : undefined;
        let agentCorrelationRef = attempt.agentCorrelationRef;
        let workspaceVersion = studio.workspaceVersion;
        let artifact: MaterializedBuildRevisionFastEditArtifact;
        let checks: Extract<
          RunEditablePreviewDraftChecksResult,
          { kind: 'completed' }
        >;
        for (let round = 0; ; round += 1) {
          if (runAgent) {
            const edited = await dependencies.editAgent.edit({
              buildRunId: target.buildRunId,
              workspacePath: prepared.workspacePath,
              baseCommit: target.baseCommit,
              feedback: target.feedback,
              revisionNumber: target.revisionNumber,
              recoveredDraft: recoveredDraft || round > 0,
              repairContext,
            });
            if (edited.kind === 'escalate') {
              attempt = await transition(dependencies.repository, attempt, {
                to: 'escalate',
                route: 'full_build',
                agentCorrelationRef: edited.agentCorrelationRef,
              });
              await dependencies.escalate({
                target,
                reason: edited.reason,
              });
              return {
                kind: 'escalated',
                attemptId: attempt.id,
                reason: edited.reason,
              };
            }
            agentCorrelationRef = edited.agentCorrelationRef;
          }
          await dependencies.stageApprovedAssets?.({
            target,
            workspacePath: prepared.workspacePath,
          });

          artifact = await dependencies.artifactStore.materialize({
            workspacePath: prepared.workspacePath,
            baseCommit: target.baseCommit,
          });
          attempt = await transition(dependencies.repository, attempt, {
            to: 'apply',
            agentCorrelationRef,
          });
          const applied = await dependencies.applyDraft({
            buildRunId: target.buildRunId,
            draftRevisionId: target.buildRevisionId,
            expectedWorkspaceVersion: workspaceVersion,
            changeSet: {
              digest: artifact.artifact.digest,
              contentRef: artifact.artifact.ref,
            },
          });
          if (applied.kind !== 'applied') {
            throw new Error(studioFailureReason(applied));
          }
          // Studio returns its current version when this digest is already
          // applied. A retry can then reuse the persisted draft and proceed
          // directly to checks without recording a duplicate change set.
          if (applied.workspaceVersion !== workspaceVersion) {
            const appended = await dependencies.repository.appendChangeSet({
              attemptId: attempt.id,
              idempotencyKey: `${attempt.id}:change:${workspaceVersion}:${artifact.artifact.digest}`,
              kind: 'edit',
              artifact: artifact.artifact,
              expectedWorkspaceVersion: workspaceVersion,
              appliedWorkspaceVersion: applied.workspaceVersion,
            });
            if (
              appended.status !== 'appended' &&
              appended.status !== 'existing'
            ) {
              throw new Error(
                `Fast-edit change set failed: ${appended.status}.`
              );
            }
            attempt = appended.attempt;
          }
          workspaceVersion = applied.workspaceVersion;
          draftRecorded = true;
          attempt = await transition(dependencies.repository, attempt, {
            to: 'checking',
            previewUpdatedAt: now().toISOString(),
          });

          const result = await dependencies.runChecks({
            buildRunId: target.buildRunId,
            draftRevisionId: target.buildRevisionId,
            workspaceVersion,
          });
          if (result.kind !== 'completed') {
            throw new Error(studioFailureReason(result));
          }
          checks = result;
          if (checks.summary.status !== 'failed') break;

          attempt = await transition(dependencies.repository, attempt, {
            to: 'failed',
            checkSummary: checks.summary,
            checksCompletedAt: now().toISOString(),
            failureCode: CHECKS_FAILED,
            failureMessage: 'The preview updated, but its checks failed.',
          });
          if (round < MAX_AUTO_REPAIR_ROUNDS) {
            attempt = await transition(dependencies.repository, attempt, {
              to: 'edit',
            });
            runAgent = true;
            repairContext = describeCheckFailures(checks.summary);
            continue;
          }
          if (dependencies.handOffToCloud) {
            await dependencies.handOffToCloud({
              target,
              reason: describeCheckFailures(checks.summary) ?? 'Checks failed.',
            });
          } else {
            await dependencies.markChecksFailed({
              target,
              summary: checks.summary,
              previewUrl: checks.previewUrl,
            });
          }
          return {
            kind: 'checks_failed',
            attemptId: attempt.id,
            previewUrl: checks.previewUrl,
            workspaceVersion: checks.workspaceVersion,
            summary: checks.summary,
          };
        }

        const validatedCommit = await dependencies.checkpoint({
          target,
          workspacePath: prepared.workspacePath,
          artifact,
        });
        await dependencies.markValidated(
          target.buildRevisionId,
          validatedCommit,
          { skipEditablePreviewApply: true, deferDeployment: true }
        );
        attempt = await transition(dependencies.repository, attempt, {
          to: 'ready',
          checkSummary: checks.summary,
          checksCompletedAt: now().toISOString(),
        });
        return {
          kind: 'ready',
          attemptId: attempt.id,
          previewUrl: checks.previewUrl,
          workspaceVersion: checks.workspaceVersion,
          validatedCommit,
        };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Fast edit failed.';
        try {
          if (attempt.status !== 'failed') {
            attempt = await transition(dependencies.repository, attempt, {
              to: 'failed',
              failureCode: draftRecorded
                ? CHECKS_UNAVAILABLE
                : 'fast_edit_failed',
              failureMessage: reason.slice(0, 500),
            });
          }
        } catch {
          // The original error remains the useful result.
        }
        await stopExecution({ target, reason }).catch(() => undefined);
        return { kind: 'failed', attemptId: attempt.id, reason };
      } finally {
        await prepared?.release().catch(() => undefined);
      }
    },

    async retry(input: {
      buildRunId: string;
      attemptId: string;
    }): Promise<BuildRevisionFastEditExecutionResult> {
      const recovery = await dependencies.repository.loadRecoveryPlan(
        input.attemptId
      );
      if (
        !recovery ||
        recovery.attempt.buildRunId !== input.buildRunId ||
        recovery.attempt.status !== 'failed'
      ) {
        return { kind: 'not_found' };
      }
      await dependencies.markRetryStarted?.({
        buildRunId: recovery.attempt.buildRunId,
        buildRevisionId: recovery.attempt.buildRevisionId,
      });
      return service.execute({
        buildRunId: input.buildRunId,
        buildRevisionId: recovery.attempt.buildRevisionId,
      });
    },

    async startRetry(input: {
      buildRunId: string;
      attemptId: string;
    }): Promise<
      { kind: 'started'; attemptId: string } | { kind: 'not_found' }
    > {
      const recovery = await dependencies.repository.loadRecoveryPlan(
        input.attemptId
      );
      if (
        !recovery ||
        recovery.attempt.buildRunId !== input.buildRunId ||
        recovery.attempt.status !== 'failed'
      ) {
        return { kind: 'not_found' };
      }
      await dependencies.markRetryStarted?.({
        buildRunId: recovery.attempt.buildRunId,
        buildRevisionId: recovery.attempt.buildRevisionId,
      });
      void service
        .execute({
          buildRunId: input.buildRunId,
          buildRevisionId: recovery.attempt.buildRevisionId,
        })
        .catch(() => undefined);
      return { kind: 'started', attemptId: recovery.attempt.id };
    },

    async rollback(input: {
      buildRunId: string;
      attemptId: string;
    }): Promise<BuildRevisionFastEditExecutionResult> {
      const recovery = await dependencies.repository.loadRecoveryPlan(
        input.attemptId
      );
      if (
        !recovery ||
        recovery.attempt.buildRunId !== input.buildRunId ||
        recovery.attempt.status !== 'failed' ||
        !dependencies.materializeRollback
      ) {
        return { kind: 'not_found' };
      }
      const target = await dependencies.loadTarget({
        buildRunId: input.buildRunId,
        buildRevisionId: recovery.attempt.buildRevisionId,
      });
      if (!target) return { kind: 'not_found' };
      let attempt = await transition(
        dependencies.repository,
        recovery.attempt,
        { to: 'rollback' }
      );
      await dependencies.markRetryStarted?.({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
      });
      const studio = await dependencies.beginStudio({
        buildRunId: target.buildRunId,
        draftRevisionId: target.buildRevisionId,
      });
      if (studio.kind !== 'ready') {
        const reason = studioFailureReason(studio);
        attempt = await transition(dependencies.repository, attempt, {
          to: 'failed',
          failureCode: 'rollback_studio_failed',
          failureMessage: reason.slice(0, 500),
        });
        await dependencies.markExecutionFailed({ target, reason });
        return {
          kind: 'failed',
          attemptId: attempt.id,
          reason,
        };
      }

      let prepared: Awaited<
        ReturnType<BuildRevisionFastEditServiceDependencies['prepareWorkspace']>
      > | null = null;
      try {
        prepared = await dependencies.prepareWorkspace(target);
        const artifact = await dependencies.materializeRollback({
          target,
          workspacePath: prepared.workspacePath,
          recovery,
        });
        const applied = await dependencies.applyDraft({
          buildRunId: target.buildRunId,
          draftRevisionId: target.buildRevisionId,
          expectedWorkspaceVersion: studio.workspaceVersion,
          changeSet: {
            digest: artifact.artifact.digest,
            contentRef: artifact.artifact.ref,
          },
        });
        if (applied.kind !== 'applied') {
          throw new Error(studioFailureReason(applied));
        }
        const appended = await dependencies.repository.appendChangeSet({
          attemptId: attempt.id,
          idempotencyKey: `${attempt.id}:rollback:${studio.workspaceVersion}:${artifact.artifact.digest}`,
          kind: 'rollback',
          artifact: artifact.artifact,
          expectedWorkspaceVersion: studio.workspaceVersion,
          appliedWorkspaceVersion: applied.workspaceVersion,
        });
        if (appended.status !== 'appended' && appended.status !== 'existing') {
          throw new Error(`Fast-edit rollback failed: ${appended.status}.`);
        }
        attempt = await transition(dependencies.repository, appended.attempt, {
          to: 'checking',
          previewUpdatedAt: now().toISOString(),
        });
        const checks = await dependencies.runChecks({
          buildRunId: target.buildRunId,
          draftRevisionId: target.buildRevisionId,
          workspaceVersion: applied.workspaceVersion,
        });
        if (checks.kind !== 'completed') {
          throw new Error(studioFailureReason(checks));
        }
        if (checks.summary.status === 'failed') {
          attempt = await transition(dependencies.repository, attempt, {
            to: 'failed',
            checkSummary: checks.summary,
            checksCompletedAt: now().toISOString(),
            failureCode: 'rollback_checks_failed',
            failureMessage: 'Rollback checks failed.',
          });
          await dependencies.markChecksFailed({
            target,
            summary: checks.summary,
            previewUrl: checks.previewUrl,
          });
          return {
            kind: 'checks_failed',
            attemptId: attempt.id,
            previewUrl: checks.previewUrl,
            workspaceVersion: checks.workspaceVersion,
            summary: checks.summary,
          };
        }
        await dependencies.markValidated(
          target.buildRevisionId,
          target.baseCommit,
          { skipEditablePreviewApply: true, deferDeployment: true }
        );
        attempt = await transition(dependencies.repository, attempt, {
          to: 'ready',
          checkSummary: checks.summary,
          checksCompletedAt: now().toISOString(),
        });
        return {
          kind: 'ready',
          attemptId: attempt.id,
          previewUrl: checks.previewUrl,
          workspaceVersion: checks.workspaceVersion,
          validatedCommit: target.baseCommit,
        };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'Rollback failed.';
        try {
          attempt = await transition(dependencies.repository, attempt, {
            to: 'failed',
            failureCode: 'rollback_failed',
            failureMessage: reason.slice(0, 500),
          });
        } catch {
          // Preserve the original rollback error.
        }
        await dependencies
          .markExecutionFailed({ target, reason })
          .catch(() => undefined);
        return { kind: 'failed', attemptId: attempt.id, reason };
      } finally {
        await prepared?.release().catch(() => undefined);
      }
    },

    async startRollback(input: {
      buildRunId: string;
      attemptId: string;
    }): Promise<
      { kind: 'started'; attemptId: string } | { kind: 'not_found' }
    > {
      const recovery = await dependencies.repository.loadRecoveryPlan(
        input.attemptId
      );
      if (
        !recovery ||
        recovery.attempt.buildRunId !== input.buildRunId ||
        recovery.attempt.status !== 'failed' ||
        !dependencies.materializeRollback
      ) {
        return { kind: 'not_found' };
      }
      await dependencies.markRetryStarted?.({
        buildRunId: recovery.attempt.buildRunId,
        buildRevisionId: recovery.attempt.buildRevisionId,
      });
      void service.rollback(input).catch(() => undefined);
      return { kind: 'started', attemptId: recovery.attempt.id };
    },
  };
  return service;
}
