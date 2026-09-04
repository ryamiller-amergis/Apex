import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionSnapshot } from '../../shared/types/agentRunLifecycle';
import type {
  BackgroundWorkflowClass,
  WorkflowRouteDecision,
} from '../../shared/types/backgroundWorkflow';
import type { SkillProvider } from '../../shared/types/projectSettings';
import type { RunGrounding, RunRef } from '../../shared/types/runGrounding';
import { resolveAgentRunHardLimitMs } from './agentRunReaperService';
import { enqueue } from './agentRunLifecycleService';
import { isFeatureEnabled } from './featureFlagService';
import { getRepoCacheDir, type RepoCacheOptions } from './repoCacheService';
import {
  cacheOptionsFromGrounding,
  isUsableBareMirror,
} from './repoRead/mirrorStore';
import { workerCanReadWithoutWorkingTree } from './repoRead/workerReadVisibility';
import {
  sharedReadCheckoutIdentityFromGrounding,
  sharedReadCheckoutService,
  type SharedReadCheckoutService,
} from './grounding/sharedReadCheckoutService';
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

/** Generation workflows that reuse the interview's shared SHA checkout (no full clone). */
const SHARED_READ_WORKFLOW_CLASSES: ReadonlySet<BackgroundWorkflowClass> = new Set([
  'prd',
  'design-doc',
  'test-cases',
]);

/**
 * Content-only scoring workflows (PRD + design-doc validation).
 * Inputs live in `.ai-pilot/kickoff-context.md` — no project-repo checkout.
 */
const SCRATCH_ONLY_WORKFLOW_CLASSES: ReadonlySet<BackgroundWorkflowClass> = new Set([
  'validation',
  'walkthrough-smart-tagging',
]);

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
  sharedReadCheckout?: Pick<
    SharedReadCheckoutService,
    'getReady' | 'retain'
  >;
  clearGenerationOutput?: (threadWorkspacePath: string) => Promise<void>;
  getRepoCacheDir?: (options: RepoCacheOptions) => string;
  isUsableBareMirror?: (path: string | undefined) => boolean;
  /**
   * True when a background worker can read without a working-tree clone:
   * HTTP repo-read is configured, or this host is not App Service (local/dev
   * workers share the same disk as the router).
   */
  workerCanReadWithoutWorkingTree?: () => boolean;
}

export { workerCanReadWithoutWorkingTree } from './repoRead/workerReadVisibility';

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
 * Overlays generation scratch inputs onto the pinned writable checkout.
 *
 * Destination `.ai-pilot/output` is cleared first so leftover PRD/design-doc
 * artifacts from a prior generation on a reused tree cannot contaminate the
 * current run. Source files (kickoff transcript, context, then any fresh
 * outputs already on the thread workspace) win after the clear.
 */
export async function prepareBackgroundWorkflowWorkspace(
  threadWorkspacePath: string,
  pinnedWorkspacePath: string,
): Promise<void> {
  const source = path.resolve(threadWorkspacePath, '.ai-pilot');
  const destination = path.resolve(pinnedWorkspacePath, '.ai-pilot');
  if (source === destination) return;
  const destinationOutput = path.join(destination, 'output');
  await fs.rm(destinationOutput, { recursive: true, force: true });
  await copyDirectoryContentsSafely(source, destination);
}

/**
 * Clears prior generation outputs on the thin thread workspace used when
 * PRD/design-doc reuse the shared read checkout, or when validation runs
 * scratch-only (kickoff-context only; no project-repo checkout).
 */
export async function clearBackgroundGenerationOutput(
  threadWorkspacePath: string,
): Promise<void> {
  const outputDirectory = path.resolve(
    threadWorkspacePath,
    '.ai-pilot',
    'output',
  );
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
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

function resolveReadySharedCheckoutPath(
  grounding: RunGrounding,
  shared: Pick<SharedReadCheckoutService, 'getReady' | 'retain'>,
): string | null {
  const ready = shared.getReady(
    sharedReadCheckoutIdentityFromGrounding(grounding),
  );
  if (!ready?.workspacePath) return null;
  shared.retain(sharedReadCheckoutIdentityFromGrounding(grounding));
  return ready.workspacePath;
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
  const clearGenerationOutput =
    dependencies.clearGenerationOutput ?? clearBackgroundGenerationOutput;
  const enqueueRun = dependencies.enqueue ?? enqueue;
  const hardLimitMs = dependencies.resolveHardLimitMs ?? resolveAgentRunHardLimitMs;
  const emitEvent = dependencies.trackEvent ?? trackEvent;
  const now = dependencies.now ?? Date.now;
  const sharedReadCheckout =
    dependencies.sharedReadCheckout ?? sharedReadCheckoutService;
  const repositoryPreparation =
    dependencies.repositoryPreparation ??
    (dependencies.materializeRunGroundingWithPath
      ? createRepositoryPreparationService({
          materializeWritable: materialize,
          telemetry: emitEvent,
          now,
        })
      : repositoryPreparationService);
  const resolveMirrorPath = dependencies.getRepoCacheDir ?? getRepoCacheDir;
  const mirrorUsable = dependencies.isUsableBareMirror ?? isUsableBareMirror;
  const canSkipWorkingTree =
    dependencies.workerCanReadWithoutWorkingTree
    ?? (() => workerCanReadWithoutWorkingTree());

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

    // PRD / design-doc validation: score content from kickoff-context only.
    // No grounding, shared checkout, or MaxView clone.
    if (SCRATCH_ONLY_WORKFLOW_CLASSES.has(input.workflowClass)) {
      try {
        await clearGenerationOutput(prepared.threadWorkspacePath);
      } catch {
        return recoverPreparation(
          input,
          'workspace-preparation-failed',
          preparationStartedAt,
        );
      }

      const workspaceRef = prepared.threadWorkspacePath;
      const materializationReason = 'scratch-only';
      safeTrack(
        'background.materialization.outcome',
        {
          workflowClass: input.workflowClass,
          project: input.destinationRun.project,
          route: 'worker',
          reason: materializationReason,
        },
        { durationMs: Math.max(0, now() - preparationStartedAt) },
      );

      const snapshot: ExecutionSnapshot = {
        prompt: prepared.prompt,
        model: prepared.model,
        workspaceRef,
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
      routeDecision(input, 'worker', materializationReason);
      return {
        route: 'worker',
        workspacePath: workspaceRef,
        runId: enqueued.runId,
      };
    }

    if (!isUsableTargetGrounding(prepared.targetGrounding, input.destinationRun)) {
      return recoverPreparation(
        input,
        'grounding-unavailable',
        preparationStartedAt,
      );
    }

    // PRD / design-doc / test-cases: prefer the bare mirror when the worker
    // can actually open it (same disk or HTTP). Else reuse the interview's
    // warm shared SHA tree. Thin writable cwd = thread workspace.
    let workspaceRef: string | undefined;
    let checkoutRef: string | undefined;
    let mirrorRef: string | undefined;
    let groundedSha: string | undefined;
    let repository: string | undefined;
    let provider: SkillProvider | undefined;
    let materializationReason = 'materialized';

    if (SHARED_READ_WORKFLOW_CLASSES.has(input.workflowClass)) {
      try {
        const cacheOptions = cacheOptionsFromGrounding(prepared.targetGrounding);
        const mirrorPath = resolveMirrorPath(cacheOptions);
        if (mirrorUsable(mirrorPath) && canSkipWorkingTree()) {
          await clearGenerationOutput(prepared.threadWorkspacePath);
          workspaceRef = prepared.threadWorkspacePath;
          mirrorRef = mirrorPath;
          groundedSha = prepared.targetGrounding.groundedSha;
          repository = prepared.targetGrounding.repository;
          provider = cacheOptions.provider;
          materializationReason = 'bare-mirror-read';
          safeTrack(
            'grounding.materialization.local-reuse',
            {
              workflowClass: input.workflowClass,
              project: input.destinationRun.project,
              source: 'bare-mirror',
              outcome: 'thin-workspace',
            },
            { durationMs: Math.max(0, now() - preparationStartedAt) },
          );
        }
      } catch {
        // Fall through to shared checkout / writable clone.
      }

      if (!workspaceRef) {
        try {
          const sharedPath = resolveReadySharedCheckoutPath(
            prepared.targetGrounding,
            sharedReadCheckout,
          );
          if (sharedPath) {
            await clearGenerationOutput(prepared.threadWorkspacePath);
            workspaceRef = prepared.threadWorkspacePath;
            checkoutRef = sharedPath;
            materializationReason = 'shared-read-checkout';
            safeTrack(
              'grounding.materialization.local-reuse',
              {
                workflowClass: input.workflowClass,
                project: input.destinationRun.project,
                source: 'shared-read-checkout',
                outcome: 'thin-workspace',
              },
              { durationMs: Math.max(0, now() - preparationStartedAt) },
            );
          }
        } catch {
          // Fall through to the legacy writable clone path.
        }
      }
    }

    if (!workspaceRef) {
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

      workspaceRef = materialized.workspacePath;
    }

    safeTrack(
      'background.materialization.outcome',
      {
        workflowClass: input.workflowClass,
        project: input.destinationRun.project,
        route: 'worker',
        reason: materializationReason,
      },
      { durationMs: Math.max(0, now() - preparationStartedAt) },
    );

    const snapshot: ExecutionSnapshot = {
      prompt: prepared.prompt,
      model: prepared.model,
      workspaceRef,
      ...(checkoutRef ? { checkoutRef } : {}),
      ...(mirrorRef ? { mirrorRef } : {}),
      ...(groundedSha ? { groundedSha } : {}),
      ...(repository ? { repository } : {}),
      ...(provider ? { provider } : {}),
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
    routeDecision(input, 'worker', materializationReason);
    return {
      route: 'worker',
      workspacePath: workspaceRef,
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
