import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type {
  BackgroundWorkflowClass,
  WorkflowRouteDecision,
} from '../../shared/types/backgroundWorkflow';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { resolveAgentRunHardLimitMs } from './agentRunReaperService';
import { enqueue } from './agentRunLifecycleService';
import { isFeatureEnabled } from './featureFlagService';
import {
  materializeRunGroundingWithPath,
  type RunGroundingMaterializationResult,
} from './runGroundingMaterializer';
import { trackEvent } from './telemetry';
import {
  createRepositoryPreparationService,
  repositoryPreparationService,
  type RepositoryPreparationService,
  type RepositoryPreparationTarget,
} from './repositoryPreparationService';

const BACKGROUND_WORKFLOW_FLAG = 'ai-runs-background';

export interface RecoverableBackgroundWorkflowFailure {
  reason: 'materialization-unavailable';
  workflowClass: BackgroundWorkflowClass;
  project: string;
  runId: string;
}

export interface PreparedBackgroundWorkflowWorker {
  targetGrounding?: RunGrounding | null;
  repository?: RepositoryPreparationTarget;
  threadWorkspacePath: string;
  prompt: string;
  model: string;
  skillPath: string;
  projectId: string;
}

export interface BackgroundWorkflowRouteInput {
  userId: string;
  workflowClass: BackgroundWorkflowClass;
  /** Generation-thread run identity used for the pinned destination. */
  destinationRun: RunRef;
  threadId: string;
  /** Worker-only preparation, evaluated lazily after the feature flag enables routing. */
  prepareWorker(): Promise<PreparedBackgroundWorkflowWorker>;
  runInProcess(): Promise<void> | void;
  reportRecoverablePreparationFailure(
    failure: RecoverableBackgroundWorkflowFailure,
  ): Promise<void> | void;
}

type FeatureFlagEvaluator = (
  key: string,
  context: {
    userId: string;
    project: string;
    caller?: string;
  },
) => Promise<boolean>;

type MaterializeGrounding = (
  grounding: RunGrounding,
  destination: RunRef,
) => Promise<RunGroundingMaterializationResult>;

type EnqueueRun = typeof enqueue;

export interface BackgroundWorkflowRouterDependencies {
  isFeatureEnabled?: FeatureFlagEvaluator;
  materializeRunGroundingWithPath?: MaterializeGrounding;
  prepareWorkspace?: typeof prepareBackgroundWorkflowWorkspace;
  enqueue?: EnqueueRun;
  resolveHardLimitMs?: () => number;
  trackEvent?: typeof trackEvent;
  now?: () => number;
  repositoryPreparation?: Pick<RepositoryPreparationService, 'prepareWritable'>;
}

export interface BackgroundWorkflowRouter {
  route(input: BackgroundWorkflowRouteInput): Promise<WorkflowRouteDecision>;
}

async function copyDirectoryContentsSafely(
  sourceDirectory: string,
  destinationDirectory: string,
): Promise<void> {
  await fs.mkdir(destinationDirectory, { recursive: true });
  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });

  for (const entry of entries) {
    const source = path.join(sourceDirectory, entry.name);
    const destination = path.join(destinationDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Refusing to merge a symbolic link from .ai-pilot');
    }
    if (entry.isDirectory()) {
      await copyDirectoryContentsSafely(source, destination);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('Refusing to merge a non-file entry from .ai-pilot');
    }
    await fs.copyFile(source, destination);
  }
}

/**
 * Idempotently overlays generation scratch inputs and outputs onto the pinned
 * checkout. Existing destination-only files are preserved for safe retries.
 */
export async function prepareBackgroundWorkflowWorkspace(
  threadWorkspacePath: string,
  pinnedWorkspacePath: string,
): Promise<void> {
  const source = path.resolve(threadWorkspacePath, '.ai-pilot');
  const destination = path.resolve(pinnedWorkspacePath, '.ai-pilot');
  if (source === destination) return;
  await copyDirectoryContentsSafely(source, destination);
}

function isUsableTargetGrounding(
  grounding: RunGrounding | null | undefined,
  destination: RunRef,
): grounding is RunGrounding {
  return Boolean(
    grounding
      && grounding.repoRole === 'target'
      && grounding.isActive
      && grounding.project === destination.project
      && grounding.groundedSha.trim().length > 0,
  );
}

export function createBackgroundWorkflowRouter(
  dependencies: BackgroundWorkflowRouterDependencies = {},
): BackgroundWorkflowRouter {
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  const materialize =
    dependencies.materializeRunGroundingWithPath
    ?? materializeRunGroundingWithPath;
  const prepareWorkspace =
    dependencies.prepareWorkspace ?? prepareBackgroundWorkflowWorkspace;
  const enqueueRun = dependencies.enqueue ?? enqueue;
  const hardLimitMs = dependencies.resolveHardLimitMs ?? resolveAgentRunHardLimitMs;
  const emitEvent = dependencies.trackEvent ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const repositoryPreparation =
    dependencies.repositoryPreparation ??
    (dependencies.materializeRunGroundingWithPath
      ? createRepositoryPreparationService({
          materializeWritable: materialize,
          telemetry: emitEvent,
          now,
        })
      : repositoryPreparationService);

  const safeTrack = (
    name: string,
    properties: Record<string, string>,
    measurements?: Record<string, number>,
  ): void => {
    try {
      emitEvent(name, properties, measurements);
    } catch {
      // Telemetry is best effort and must not affect routing.
    }
  };

  const routeDecision = (
    input: BackgroundWorkflowRouteInput,
    route: WorkflowRouteDecision['route'],
    reason: string,
  ): void => {
    safeTrack('background.route.decision', {
      workflowClass: input.workflowClass,
      project: input.destinationRun.project,
      route,
      reason,
    });
  };

  const recoverPreparation = async (
    input: BackgroundWorkflowRouteInput,
    reason: string,
    startedAt: number,
  ): Promise<WorkflowRouteDecision> => {
    safeTrack(
      'background.materialization.outcome',
      {
        workflowClass: input.workflowClass,
        project: input.destinationRun.project,
        route: 'in-process',
        reason,
      },
      { durationMs: Math.max(0, now() - startedAt) },
    );
    routeDecision(
      input,
      'in-process',
      'materialization-unavailable',
    );
    safeTrack('background.route.fallback', {
      workflowClass: input.workflowClass,
      project: input.destinationRun.project,
      route: 'in-process',
      reason,
      outcome: 'started',
    });
    let execution: Promise<void>;
    try {
      execution = Promise.resolve(input.runInProcess());
    } catch {
      execution = Promise.reject(new Error('In-process fallback failed'));
    }
    void execution.catch(async () => {
      safeTrack('background.route.fallback', {
        workflowClass: input.workflowClass,
        project: input.destinationRun.project,
        route: 'in-process',
        reason,
        outcome: 'failed',
      });
      await Promise.resolve(
        input.reportRecoverablePreparationFailure({
          reason: 'materialization-unavailable',
          workflowClass: input.workflowClass,
          project: input.destinationRun.project,
          runId: input.destinationRun.runId,
        }),
      ).catch(() => undefined);
    });
    return {
      route: 'in-process',
      reason: 'materialization-unavailable',
      fallbackStarted: true,
    };
  };

  const routeWorker = async (
    input: BackgroundWorkflowRouteInput,
  ): Promise<WorkflowRouteDecision> => {
    const preparationStartedAt = now();
    let prepared: PreparedBackgroundWorkflowWorker;
    try {
      prepared = await input.prepareWorker();
    } catch {
      return recoverPreparation(
        input,
        'worker-preparation-failed',
        preparationStartedAt,
      );
    }

    if (!isUsableTargetGrounding(prepared.targetGrounding, input.destinationRun)) {
      return recoverPreparation(
        input,
        'grounding-unavailable',
        preparationStartedAt,
      );
    }

    let materialized: RunGroundingMaterializationResult;
    try {
      materialized = await repositoryPreparation.prepareWritable({
        destinationRun: input.destinationRun,
        workflowClass: input.workflowClass,
        targetGrounding: prepared.targetGrounding,
        repository: prepared.repository,
      });
    } catch {
      return recoverPreparation(
        input,
        'materialization-failed',
        preparationStartedAt,
      );
    }

    if (
      materialized.state !== 'materialized'
      || !materialized.workspacePath
    ) {
      return recoverPreparation(
        input,
        'materialization-unavailable',
        preparationStartedAt,
      );
    }

    try {
      await prepareWorkspace(
        prepared.threadWorkspacePath,
        materialized.workspacePath,
      );
    } catch {
      return recoverPreparation(
        input,
        'workspace-preparation-failed',
        preparationStartedAt,
      );
    }

    safeTrack(
      'background.materialization.outcome',
      {
        workflowClass: input.workflowClass,
        project: input.destinationRun.project,
        route: 'worker',
        reason: 'materialized',
      },
      { durationMs: Math.max(0, now() - preparationStartedAt) },
    );

    const snapshot: ExecutionSnapshot = {
      prompt: prepared.prompt,
      model: prepared.model,
      workspaceRef: materialized.workspacePath,
      workflowClass: input.workflowClass,
      skillPath: prepared.skillPath,
      projectId: prepared.projectId,
      threadId: input.threadId,
    };
    const timeoutAt = new Date(now() + hardLimitMs()).toISOString();
    let enqueued: Awaited<ReturnType<EnqueueRun>>;
    try {
      enqueued = await enqueueRun({
        threadId: input.threadId,
        projectId: prepared.projectId,
        snapshot,
        timeoutAt,
        runId: input.destinationRun.runId,
      });
    } catch {
      return recoverPreparation(
        input,
        'worker-enqueue-failed',
        preparationStartedAt,
      );
    }
    routeDecision(input, 'worker', 'materialized');
    return {
      route: 'worker',
      workspacePath: materialized.workspacePath,
      runId: enqueued.runId,
    };
  };

  return {
    async route(input) {
      let enabled = false;
      let evaluationReason = 'flag-disabled';
      try {
        enabled = await evaluateFlag(BACKGROUND_WORKFLOW_FLAG, {
          userId: input.userId,
          project: input.destinationRun.project,
          caller: input.workflowClass,
        });
      } catch {
        evaluationReason = 'flag-evaluation-error';
      }

      // Retain enabled after two stable sprints at full rollout.
      // @feature-flag:ai-runs-background start winner=enabled
      if (!enabled) {
        // @feature-flag:ai-runs-background disabled-start
        routeDecision(input, 'in-process', evaluationReason);
        let execution: Promise<void>;
        try {
          execution = Promise.resolve(input.runInProcess());
        } catch {
          execution = Promise.reject(new Error('In-process workflow failed'));
        }
        void execution.catch(async () => {
          await Promise.resolve(
            input.reportRecoverablePreparationFailure({
              reason: 'materialization-unavailable',
              workflowClass: input.workflowClass,
              project: input.destinationRun.project,
              runId: input.destinationRun.runId,
            }),
          ).catch(() => undefined);
        });
        const decision: WorkflowRouteDecision = {
          route: 'in-process',
          reason: 'flag-disabled',
        };
        // @feature-flag:ai-runs-background disabled-end
        return decision;
      }

      // @feature-flag:ai-runs-background enabled-start
      const decision = await routeWorker(input);
      // @feature-flag:ai-runs-background enabled-end
      // @feature-flag:ai-runs-background end
      return decision;
    },
  };
}

export const backgroundWorkflowRouter = createBackgroundWorkflowRouter();

export function routeBackgroundWorkflow(
  input: BackgroundWorkflowRouteInput,
): Promise<WorkflowRouteDecision> {
  return backgroundWorkflowRouter.route(input);
}
