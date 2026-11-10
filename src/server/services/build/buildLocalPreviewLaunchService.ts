import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import type {
  BuildRunStatus,
  BuildSupportContact,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import {
  buildEvents,
  buildPreviewArtifacts,
  buildPreviewInstances,
  buildRevisions,
  buildRuns,
} from '../../db/schema';
import { resolveDataRoot } from '../../utils/dataDir';
import { git, safeArgs } from '../../utils/asyncGit';
import { checkoutDefaultBranch, getWorkspaceDir } from '../repoCheckoutService';
import { removeDirectoryAsync } from '../repoWorkspaceService';
import { WORKTREE_GIT_TIMEOUT_MS } from '../repoGitSettings';
import { defaultBuildDeploymentService } from '../buildDeploymentService';
import { defaultPreviewLeaseService } from '../buildPreviewLeaseService';
import { appendBuildEvent } from '../buildEventsService';
import { createDrizzleBrowserCheckRepository } from './buildPreviewBrowserCheckRepository';
import { createLocalBrowserEvidenceStore } from './buildPreviewBrowserEvidenceStore';
import { createBuildPreviewBrowserVerifier } from './buildPreviewBrowserVerifier';
import { defaultBuildPreviewCompletionPort } from './buildPreviewCompletionStore';
import { evaluateBuildPreviewCompletion } from './buildPreviewCompletionInvariant';
import { createDrizzleLocalPreviewInstanceStore } from './buildPreviewLocalInstanceStore';
import {
  createLocalBuildPreviewWalkingSkeleton,
  type LocalPreviewWalkingSkeletonOutcome,
} from './buildPreviewLocalWalkingSkeleton';
import { createDockerPostgresSandboxDataProvider } from './dockerPostgresSandboxDataProvider';
import {
  createDockerCommandRunner,
  createDockerPreviewResourceStore,
  dockerResourceName,
} from './dockerPreviewRuntime';
import { studioNetworkNameFor } from './dockerEditablePreviewSessionProvider';
import { editablePreviewSessionIdForBuild } from './buildEditablePreviewSessionService';
import { linkStudioToRuntimeApi } from './studioRuntimeApiLink';
import { createDockerSandboxProvider } from './dockerSandboxProvider';
import { defaultBuildEditablePreviewSessionService } from './buildEditablePreviewLocalService';
import { createGoldenStackPreviewJourneyRunner } from './goldenStackPreviewJourneyRunner';

const execFileAsync = promisify(execFile);
const LOCAL_PIPELINE_PREFIX = 'local-preview:';
const RUNTIME_CONTAINER = 'local-preview-runtime';
const LOCAL_PREVIEW_TTL_MS = 2 * 60 * 60 * 1_000;
const BUILD_IMAGE =
  'node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const ACTIVE_INSTANCE_STATES = [
  'requested',
  'provisioning',
  'starting',
  'verifying',
  'ready',
  'suspended',
  'terminating',
] as const;
const STARTABLE_RUN_STATES: ReadonlySet<BuildRunStatus> = new Set([
  'deploying',
  'deployment_failed',
  'accepted',
]);
const STARTABLE_DEPLOYMENT_STATES = new Set([
  'not_started',
  'queued',
  'deploying',
  'failed',
]);

export interface LocalPreviewLaunchActor {
  userId: string;
  isProjectAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface LocalPreviewLaunchTarget {
  buildRunId: string;
  revisionId: string;
  revisionNumber: number;
  project: string;
  repository: string;
  requesterUserId: string;
  supportContacts: Array<Pick<BuildSupportContact, 'userId'>>;
  integrationBranch: string | null;
  validatedCommit: string | null;
  previewRolloutMode: 'legacy_static' | 'live';
  runStatus: BuildRunStatus;
  deploymentStatus: string;
  hasActivePreview: boolean;
}

export interface PreparedLocalPreviewRuntime {
  digest: string;
  sizeBytes: number;
  blobRef: {
    container: string;
    key: string;
  };
  bundlePath: string;
  runnerImage: string;
  templateVersion: string;
}

export interface ActivatedLocalPreview {
  kind: 'activated';
  pipelineRunId: string;
  expiresAt: string;
}

export type LocalPreviewLaunchResult =
  | { kind: 'started'; revisionNumber: number }
  | { kind: 'unavailable' }
  | { kind: 'not_found' }
  | { kind: 'forbidden' }
  | { kind: 'not_ready'; message: string }
  | { kind: 'already_active' }
  | { kind: 'busy' };

interface LocalPreviewLaunchDependencies {
  isAvailable(): boolean;
  loadTarget(buildRunId: string): Promise<LocalPreviewLaunchTarget | null>;
  activateTarget(
    target: LocalPreviewLaunchTarget
  ): Promise<ActivatedLocalPreview | { kind: 'busy' }>;
  prepareRuntime(
    target: LocalPreviewLaunchTarget
  ): Promise<PreparedLocalPreviewRuntime>;
  prepareEditablePreview(
    target: LocalPreviewLaunchTarget
  ): Promise<{ previewUrl: string }>;
  runPreview(input: {
    target: LocalPreviewLaunchTarget;
    runtime: PreparedLocalPreviewRuntime;
    pipelineRunId: string;
    expiresAt: string;
    stablePreviewUrl: string;
  }): Promise<LocalPreviewWalkingSkeletonOutcome | { kind: string }>;
  finalizeLease(
    target: LocalPreviewLaunchTarget,
    expiresAt: string
  ): Promise<void>;
  reportError(
    target: LocalPreviewLaunchTarget,
    error: unknown
  ): Promise<void> | void;
}

function actorMayLaunch(
  actor: LocalPreviewLaunchActor,
  target: LocalPreviewLaunchTarget
): boolean {
  return (
    actor.isSuperAdmin ||
    actor.isProjectAdmin ||
    actor.userId === target.requesterUserId ||
    target.supportContacts.some((contact) => contact.userId === actor.userId)
  );
}

function validateTarget(
  target: LocalPreviewLaunchTarget
): { kind: 'ok' } | { kind: 'not_ready'; message: string } {
  if (!target.validatedCommit) {
    return { kind: 'not_ready', message: 'A validated revision is required.' };
  }
  if (!target.integrationBranch) {
    return {
      kind: 'not_ready',
      message: 'The integration branch is unavailable.',
    };
  }
  if (target.runStatus === 'preview_ready') {
    return {
      kind: 'not_ready',
      message: 'The revision already has a preview.',
    };
  }
  if (!STARTABLE_RUN_STATES.has(target.runStatus)) {
    return {
      kind: 'not_ready',
      message: 'The build is not ready for a local preview.',
    };
  }
  if (target.deploymentStatus === 'succeeded') {
    return {
      kind: 'not_ready',
      message: 'The revision already has a preview.',
    };
  }
  if (!STARTABLE_DEPLOYMENT_STATES.has(target.deploymentStatus)) {
    return {
      kind: 'not_ready',
      message: 'The build is not ready for a local preview.',
    };
  }
  return { kind: 'ok' };
}

export function createLocalBuildPreviewLaunchService(
  dependencies: LocalPreviewLaunchDependencies
) {
  const inFlight = new Set<string>();

  return {
    async start(input: {
      buildRunId: string;
      project: string;
      actor: LocalPreviewLaunchActor;
    }): Promise<LocalPreviewLaunchResult> {
      if (!dependencies.isAvailable()) return { kind: 'unavailable' };

      const target = await dependencies.loadTarget(input.buildRunId);
      if (!target || target.project !== input.project)
        return { kind: 'not_found' };
      if (!actorMayLaunch(input.actor, target)) return { kind: 'forbidden' };
      if (target.hasActivePreview || inFlight.has(target.revisionId)) {
        return { kind: 'already_active' };
      }

      const validation = validateTarget(target);
      if (validation.kind !== 'ok') return validation;

      inFlight.add(target.revisionId);
      let activation: ActivatedLocalPreview | { kind: 'busy' };
      try {
        activation = await dependencies.activateTarget(target);
      } catch (error) {
        inFlight.delete(target.revisionId);
        throw error;
      }
      if (activation.kind === 'busy') {
        inFlight.delete(target.revisionId);
        return activation;
      }

      void (async () => {
        try {
          const [runtime, editablePreview] = await Promise.all([
            dependencies.prepareRuntime(target),
            dependencies.prepareEditablePreview(target),
          ]);
          const outcome = await dependencies.runPreview({
            target,
            runtime,
            pipelineRunId: activation.pipelineRunId,
            expiresAt: activation.expiresAt,
            stablePreviewUrl: editablePreview.previewUrl,
          });
          if (outcome.kind === 'failed') {
            const failed = outcome as {
              stage?: string;
              failureCode?: string;
            };
            throw new Error(
              `Local preview ${failed.stage ?? 'provider'} failed: ${
                failed.failureCode ?? 'unknown'
              }.`
            );
          }
          if (outcome.kind === 'blocked') {
            const blocked = outcome as { reason?: string };
            throw new Error(
              `Local preview browser verification blocked completion: ${
                blocked.reason ?? 'unknown'
              }.`
            );
          }
          if (outcome.kind === 'preview_ready') {
            await dependencies.finalizeLease(target, activation.expiresAt);
          }
        } catch (error) {
          await dependencies.reportError(target, error);
        } finally {
          inFlight.delete(target.revisionId);
        }
      })();

      return { kind: 'started', revisionNumber: target.revisionNumber };
    },
  };
}

export function isLocalBuildPreviewAvailable(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    environment.NODE_ENV !== 'production' &&
    !environment.WEBSITE_SITE_NAME &&
    !environment.CONTAINER_APP_NAME
  );
}

const STUCK_LOCAL_PREVIEW_MS = 3 * 60 * 1000;

/**
 * A local preview launch lives in the API process. A restart drops it and the
 * run stays on deploying with no instance. Restart each such preview once.
 */
export async function recoverStuckLocalPreviews(): Promise<number> {
  if (!isLocalBuildPreviewAvailable()) return 0;
  const cutoff = new Date(Date.now() - STUCK_LOCAL_PREVIEW_MS).toISOString();
  const rows = await db
    .select({
      buildRunId: buildRuns.id,
      project: buildRuns.project,
      requesterUserId: buildRuns.requestedByUserId,
      revisionId: buildRevisions.id,
    })
    .from(buildRuns)
    .innerJoin(
      buildRevisions,
      and(
        eq(buildRevisions.buildRunId, buildRuns.id),
        eq(buildRevisions.revisionNumber, buildRuns.currentRevisionNumber)
      )
    )
    .where(
      and(
        eq(buildRuns.status, 'deploying'),
        eq(buildRevisions.deploymentStatus, 'deploying'),
        sql`${buildRevisions.pipelineRunId} like 'local-preview:%'`,
        lt(buildRevisions.updatedAt, cutoff)
      )
    )
    .limit(3);

  let recovered = 0;
  for (const row of rows) {
    const [active] = await db
      .select({ id: buildPreviewInstances.id })
      .from(buildPreviewInstances)
      .innerJoin(
        buildPreviewArtifacts,
        eq(buildPreviewArtifacts.id, buildPreviewInstances.buildPreviewArtifactId)
      )
      .where(
        and(
          eq(buildPreviewArtifacts.buildRevisionId, row.revisionId),
          inArray(buildPreviewInstances.state, ACTIVE_INSTANCE_STATES)
        )
      )
      .limit(1);
    if (active) continue;

    let containerRunning = false;
    try {
      const { stdout } = await execFileAsync(
        'docker',
        ['ps', '-q', '--filter', `name=${row.revisionId}`],
        { windowsHide: true, timeout: 8_000 }
      );
      containerRunning = stdout.trim().length > 0;
    } catch {
      containerRunning = false;
    }
    if (containerRunning) continue;

    const recorded = await appendBuildEvent({
      buildRunId: row.buildRunId,
      buildRevisionId: row.revisionId,
      eventType: 'local_preview.relaunched',
      message: 'Restarted the preview after it stopped.',
      dedupeKey: `local-preview-relaunch:${row.revisionId}`,
    });
    if (!recorded.inserted) continue;

    const started = await defaultBuildLocalPreviewLaunchService.start({
      buildRunId: row.buildRunId,
      project: row.project,
      actor: {
        userId: row.requesterUserId,
        isProjectAdmin: false,
        isSuperAdmin: true,
      },
    });
    if (started.kind === 'started') recovered += 1;
  }
  return recovered;
}

async function loadTarget(
  buildRunId: string
): Promise<LocalPreviewLaunchTarget | null> {
  const [row] = await db
    .select({
      buildRunId: buildRuns.id,
      revisionId: buildRevisions.id,
      revisionNumber: buildRevisions.revisionNumber,
      project: buildRuns.project,
      repository: buildRuns.repository,
      requesterUserId: buildRuns.requestedByUserId,
      supportContacts: buildRuns.supportContacts,
      integrationBranch: buildRuns.integrationBranch,
      validatedCommit: buildRevisions.validatedCommit,
      previewRolloutMode: buildRevisions.previewRolloutMode,
      runStatus: buildRuns.status,
      deploymentStatus: buildRevisions.deploymentStatus,
    })
    .from(buildRuns)
    .innerJoin(
      buildRevisions,
      and(
        eq(buildRevisions.buildRunId, buildRuns.id),
        eq(buildRevisions.revisionNumber, buildRuns.currentRevisionNumber)
      )
    )
    .where(eq(buildRuns.id, buildRunId))
    .limit(1);
  if (!row) return null;

  const [active] = await db
    .select({ id: buildPreviewInstances.id })
    .from(buildPreviewInstances)
    .innerJoin(
      buildPreviewArtifacts,
      eq(buildPreviewArtifacts.id, buildPreviewInstances.buildPreviewArtifactId)
    )
    .where(
      and(
        eq(buildPreviewArtifacts.buildRevisionId, row.revisionId),
        inArray(buildPreviewInstances.state, ACTIVE_INSTANCE_STATES),
        gt(buildPreviewInstances.expiresAt, new Date().toISOString())
      )
    )
    .limit(1);

  return {
    ...row,
    supportContacts: row.supportContacts.map((contact) => ({
      userId: contact.userId,
    })),
    hasActivePreview: Boolean(active),
  };
}

async function activateTarget(
  target: LocalPreviewLaunchTarget
): Promise<ActivatedLocalPreview | { kind: 'busy' }> {
  const lease = await defaultPreviewLeaseService.tryGrantLease({
    project: target.project,
    repository: target.repository,
    buildRunId: target.buildRunId,
    buildRevisionId: target.revisionId,
    ttlMs: LOCAL_PREVIEW_TTL_MS,
  });
  if (!lease.granted || !lease.lease) return { kind: 'busy' };

  const pipelineRunId = `${LOCAL_PIPELINE_PREFIX}${target.revisionId}`;
  const now = new Date().toISOString();
  const activated = await db.transaction(async (tx) => {
    const revisions = await tx
      .update(buildRevisions)
      .set({
        pipelineRunId,
        deploymentStatus: 'deploying',
        deploymentQueuedAt: now,
        deployedAt: null,
        deploymentFailedStage: null,
        deploymentPipelineUrl: null,
        previewUrl: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(buildRevisions.id, target.revisionId),
          eq(buildRevisions.buildRunId, target.buildRunId),
          eq(buildRevisions.validatedCommit, target.validatedCommit as string),
          inArray(buildRevisions.deploymentStatus, [
            'not_started',
            'queued',
            'deploying',
            'failed',
          ])
        )
      )
      .returning({ id: buildRevisions.id });
    if (revisions.length !== 1) return false;

    if (target.runStatus === 'accepted') return true;
    const runs = await tx
      .update(buildRuns)
      .set({ status: 'deploying', updatedAt: now })
      .where(
        and(
          eq(buildRuns.id, target.buildRunId),
          inArray(buildRuns.status, ['deploying', 'deployment_failed'])
        )
      )
      .returning({ id: buildRuns.id });
    return runs.length === 1;
  });
  if (!activated) {
    throw new Error('The build changed before the local preview could start.');
  }

  return {
    kind: 'activated',
    pipelineRunId,
    expiresAt: lease.lease.expiresAt,
  };
}

interface PreviewManifest {
  template?: { id?: string; version?: string };
  runner?: { id?: string; version?: string };
  bundle?: { output?: string };
}

export async function installGoldenStackPreviewAdapter(
  workspace: string,
  adapterRoot = path.resolve(process.cwd(), 'templates', 'full-stack-express')
): Promise<boolean> {
  const manifestPath = path.join(workspace, 'apex.preview.json');
  try {
    await access(manifestPath);
    return false;
  } catch {
    // Older Golden Stack revisions need the versioned preview build adapter.
  }

  await Promise.all([
    access(path.join(workspace, 'package.json')),
    access(path.join(workspace, 'apps', 'api')),
    access(path.join(workspace, 'apps', 'web')),
  ]).catch(() => {
    throw new Error(
      'The validated revision is not a supported full-stack-express workspace.'
    );
  });
  await Promise.all([
    copyFile(
      path.join(adapterRoot, 'apex.preview.json'),
      path.join(workspace, 'apex.preview.json')
    ),
    copyFile(
      path.join(adapterRoot, 'Dockerfile.preview'),
      path.join(workspace, 'Dockerfile.preview')
    ),
    cp(
      path.join(adapterRoot, 'scripts', 'preview'),
      path.join(workspace, 'scripts', 'preview'),
      { recursive: true }
    ),
  ]);
  return true;
}

function safeManifestOutput(root: string, output: string): string {
  const resolved = path.resolve(root, output);
  const relative = path.relative(root, resolved);
  if (
    !output ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    path.extname(resolved) !== '.tar'
  ) {
    throw new Error('The preview manifest has an invalid bundle output path.');
  }
  return resolved;
}

async function buildRuntimeBundleInContainer(input: {
  workspace: string;
  bundleOutput: string;
  containerName: string;
}): Promise<void> {
  const bundlePath = safeManifestOutput(input.workspace, input.bundleOutput);
  await mkdir(path.dirname(bundlePath), { recursive: true });
  // An API restart mid-build leaves the old container behind under the same name.
  await execFileAsync('docker', ['rm', '--force', input.containerName], {
    windowsHide: true,
    timeout: 120_000,
  }).catch(() => undefined);
  await execFileAsync(
    'docker',
    [
      'create',
      '--name',
      input.containerName,
      '--workdir',
      '/workspace',
      BUILD_IMAGE,
      'sh',
      '-lc',
      'corepack enable && corepack prepare pnpm@10.34.9 --activate && corepack pnpm install --frozen-lockfile && corepack pnpm build && node scripts/preview/build-runtime-bundle.mjs',
    ],
    { windowsHide: true, timeout: 120_000 }
  );
  try {
    await execFileAsync(
      'docker',
      [
        'cp',
        `${input.workspace}${path.sep}.`,
        `${input.containerName}:/workspace`,
      ],
      {
        windowsHide: true,
        timeout: 5 * 60_000,
        maxBuffer: 20 * 1024 * 1024,
      }
    );
    await execFileAsync('docker', ['start', '--attach', input.containerName], {
      windowsHide: true,
      timeout: 20 * 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    await execFileAsync(
      'docker',
      [
        'cp',
        `${input.containerName}:/workspace/${input.bundleOutput.replace(
          /\\/g,
          '/'
        )}`,
        bundlePath,
      ],
      {
        windowsHide: true,
        timeout: 2 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
  } finally {
    await execFileAsync('docker', ['rm', '--force', input.containerName], {
      windowsHide: true,
      timeout: 120_000,
    }).catch(() => undefined);
  }
}

async function prepareRuntime(
  target: LocalPreviewLaunchTarget
): Promise<PreparedLocalPreviewRuntime> {
  const [cached] = await db
    .select({
      digest: buildPreviewArtifacts.digest,
      sizeBytes: buildPreviewArtifacts.sizeBytes,
      blobRef: buildPreviewArtifacts.blobRef,
      templateVersion: buildPreviewArtifacts.templateVersion,
      commit: buildPreviewArtifacts.commit,
    })
    .from(buildPreviewArtifacts)
    .where(eq(buildPreviewArtifacts.buildRevisionId, target.revisionId))
    .limit(1);
  const digestMatch = /^sha256:([0-9a-f]{64})$/.exec(cached?.digest ?? '');
  if (cached && digestMatch && cached.commit === target.validatedCommit) {
    const bundlePath = path.join(
      resolveDataRoot(),
      'build-preview-runtime',
      digestMatch[1],
      'runtime.tar'
    );
    const runnerImage = `apex/full-stack-express-preview-runner:${(
      target.validatedCommit as string
    ).slice(0, 12)}`;
    const [bundle, image] = await Promise.all([
      stat(bundlePath).catch(() => null),
      execFileAsync('docker', ['image', 'inspect', runnerImage], {
        windowsHide: true,
        timeout: 120_000,
      }).catch(() => null),
    ]);
    if (bundle?.isFile() && bundle.size === cached.sizeBytes && image) {
      return {
        digest: cached.digest,
        sizeBytes: cached.sizeBytes,
        blobRef: cached.blobRef,
        bundlePath,
        runnerImage,
        templateVersion: cached.templateVersion,
      };
    }
  }

  const workspace = await checkoutDefaultBranch({
    project: target.project,
    repo: target.repository,
    branch: target.integrationBranch as string,
    sessionId: `build-preview-${target.revisionId}`,
    provider: 'ado',
  });
  try {
    await git(
      safeArgs(workspace, [
        'checkout',
        '--detach',
        target.validatedCommit as string,
      ]),
      { cwd: workspace, timeout: WORKTREE_GIT_TIMEOUT_MS }
    );
    const checkedOut = (
      await git(safeArgs(workspace, ['rev-parse', 'HEAD']), {
        cwd: workspace,
        timeout: WORKTREE_GIT_TIMEOUT_MS,
      })
    ).trim();
    if (checkedOut !== target.validatedCommit) {
      throw new Error(
        'The validated revision could not be materialized exactly.'
      );
    }

    await installGoldenStackPreviewAdapter(workspace);
    const manifestPath = path.join(workspace, 'apex.preview.json');
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as PreviewManifest;
    if (
      manifest.template?.id !== 'full-stack-express' ||
      !manifest.template.version ||
      manifest.runner?.id !== 'full-stack-express' ||
      !manifest.runner.version ||
      !manifest.bundle?.output
    ) {
      throw new Error(
        'The validated revision does not contain a supported Golden Stack preview manifest.'
      );
    }

    await buildRuntimeBundleInContainer({
      workspace,
      bundleOutput: manifest.bundle.output,
      containerName: `apex-preview-build-${target.revisionId}`,
    });

    const runnerImage = `apex/full-stack-express-preview-runner:${(
      target.validatedCommit as string
    ).slice(0, 12)}`;
    await execFileAsync(
      'docker',
      ['build', '--file', 'Dockerfile.preview', '--tag', runnerImage, '.'],
      {
        cwd: workspace,
        windowsHide: true,
        timeout: 20 * 60_000,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    const builtBundlePath = safeManifestOutput(
      workspace,
      manifest.bundle.output
    );
    const bytes = await readFile(builtBundlePath);
    const digestHex = createHash('sha256').update(bytes).digest('hex');
    const digest = `sha256:${digestHex}`;
    const artifactRoot = path.join(
      resolveDataRoot(),
      'build-preview-runtime',
      digestHex
    );
    const bundlePath = path.join(artifactRoot, 'runtime.tar');
    await mkdir(artifactRoot, { recursive: true });
    await copyFile(builtBundlePath, bundlePath);
    const metadata = await stat(bundlePath);

    return {
      digest,
      sizeBytes: metadata.size,
      blobRef: {
        container: RUNTIME_CONTAINER,
        key: `${digestHex}/runtime.tar`,
      },
      bundlePath,
      runnerImage,
      templateVersion: manifest.template.version,
    };
  } finally {
    await removeDirectoryAsync(
      getWorkspaceDir(`build-preview-${target.revisionId}`)
    );
  }
}

const activeProviders = new Map<
  string,
  {
    data: ReturnType<typeof createDockerPostgresSandboxDataProvider>;
    sandbox: ReturnType<typeof createDockerSandboxProvider>;
  }
>();

async function runPreview(input: {
  target: LocalPreviewLaunchTarget;
  runtime: PreparedLocalPreviewRuntime;
  pipelineRunId: string;
  expiresAt: string;
  stablePreviewUrl: string;
}): Promise<LocalPreviewWalkingSkeletonOutcome> {
  const docker = createDockerCommandRunner({ timeoutMs: 180_000 });
  const resources = createDockerPreviewResourceStore();
  const resolveRuntimeBundle = async (digest: string) => {
    if (digest !== input.runtime.digest) {
      throw new Error(`Unknown runtime bundle ${digest}.`);
    }
    return { path: input.runtime.bundlePath, digest };
  };
  const data = createDockerPostgresSandboxDataProvider({
    docker,
    resources,
    postgresImage: 'postgres:16',
    previewRunnerImage: input.runtime.runnerImage,
    resolveRuntimeBundle,
  });
  const sandbox = createDockerSandboxProvider({
    docker,
    resources,
    previewRunnerImage: input.runtime.runnerImage,
    resolveRuntimeBundle,
  });
  const walkingSkeleton = createLocalBuildPreviewWalkingSkeleton({
    store: createDrizzleLocalPreviewInstanceStore(),
    data,
    sandbox,
    browserVerifier: createBuildPreviewBrowserVerifier({
      repository: createDrizzleBrowserCheckRepository(),
      evidence: createLocalBrowserEvidenceStore(),
      runner: createGoldenStackPreviewJourneyRunner(),
    }),
    // The Studio URL is the one users see. Join it to the verified runtime's
    // API before it is published, so its /api calls reach real data.
    onPreviewVerified: ({ instanceId }) =>
      linkStudioToRuntimeApi({
        docker,
        studioNetworkName: studioNetworkNameFor(
          editablePreviewSessionIdForBuild(input.target.buildRunId)
        ),
        runtimeContainerName: dockerResourceName('app', instanceId),
      }),
    settlePreview: async (request) => {
      if (input.target.runStatus === 'accepted') {
        const gate = await defaultBuildPreviewCompletionPort.loadGate({
          revisionId: input.target.revisionId,
          project: input.target.project,
          repository: input.target.repository,
        });
        const completion = evaluateBuildPreviewCompletion({
          mode: gate.mode,
          expectedRevisionId: input.target.revisionId,
          expectedCommit: input.target.validatedCommit,
          evidence: gate.evidence,
        });
        if (!completion.satisfied) {
          return { applied: false, reason: 'preview_evidence_pending' };
        }
        const now = new Date().toISOString();
        const rows = await db
          .update(buildRevisions)
          .set({
            deploymentStatus: 'succeeded',
            previewUrl: input.stablePreviewUrl,
            deployedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(buildRevisions.id, input.target.revisionId),
              eq(buildRevisions.pipelineRunId, request.pipelineRunId),
              eq(buildRevisions.validatedCommit, request.commit),
              eq(buildRevisions.deploymentStatus, 'deploying')
            )
          )
          .returning({ id: buildRevisions.id });
        if (rows.length !== 1) return { applied: false, reason: 'duplicate' };
        await appendBuildEvent({
          buildRunId: input.target.buildRunId,
          buildRevisionId: input.target.revisionId,
          eventType: 'preview_ready',
          message:
            'The accepted revision passed its local Docker browser verification.',
          detail: {
            pipelineRunId: request.pipelineRunId,
            previewUrl: input.stablePreviewUrl,
            retainedBuildStatus: 'accepted',
          },
        });
        return { applied: true };
      }
      const settled = await defaultBuildDeploymentService.settleFromCallback({
        ...request,
        previewUrl: input.stablePreviewUrl,
      });
      if (settled.kind !== 'ok') {
        throw new Error(`Local preview settlement failed: ${settled.kind}.`);
      }
      return settled.response;
    },
  });

  const outcome = await walkingSkeleton.run({
    buildRunId: input.target.buildRunId,
    revisionId: input.target.revisionId,
    revisionNumber: input.target.revisionNumber,
    commit: input.target.validatedCommit as string,
    templateVersion: input.runtime.templateVersion,
    runtimeBundle: {
      digest: input.runtime.digest,
      sizeBytes: input.runtime.sizeBytes,
      blobRef: input.runtime.blobRef,
    },
    expiresAt: input.expiresAt,
    pipelineRunId: input.pipelineRunId,
  });
  if (outcome.kind === 'preview_ready') {
    activeProviders.set(outcome.instanceId, { data, sandbox });
  }
  return outcome;
}

async function finalizeLease(
  target: LocalPreviewLaunchTarget,
  expiresAt: string
): Promise<void> {
  await defaultPreviewLeaseService.setLeaseExpiry(target.buildRunId, expiresAt);
}

async function reportError(
  target: LocalPreviewLaunchTarget,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[local-preview] build=${target.buildRunId} revision=${target.revisionId}:`,
    message
  );
  if (target.runStatus === 'accepted') {
    const now = new Date().toISOString();
    await db
      .update(buildRevisions)
      .set({
        deploymentStatus: 'failed',
        deployedAt: now,
        deploymentFailedStage: 'local_preview',
        updatedAt: now,
      })
      .where(
        and(
          eq(buildRevisions.id, target.revisionId),
          eq(
            buildRevisions.pipelineRunId,
            `${LOCAL_PIPELINE_PREFIX}${target.revisionId}`
          ),
          eq(buildRevisions.deploymentStatus, 'deploying')
        )
      );
    await defaultPreviewLeaseService.releaseLease({
      buildRunId: target.buildRunId,
      reason: 'failure',
    });
    await appendBuildEvent({
      buildRunId: target.buildRunId,
      buildRevisionId: target.revisionId,
      eventType: 'deployment_failed',
      message: 'The local Docker preview could not be created.',
      detail: {
        failedStage: 'local_preview',
        errorExcerpt: message.slice(0, 500),
        retainedBuildStatus: 'accepted',
      },
    });
    return;
  }
  await defaultBuildDeploymentService.settleFromCallback({
    pipelineRunId: `${LOCAL_PIPELINE_PREFIX}${target.revisionId}`,
    commit: target.validatedCommit as string,
    status: 'failed',
    failedStage: 'local_preview',
    errorText: message.slice(0, 2_000),
  });
}

export const defaultBuildLocalPreviewLaunchService =
  createLocalBuildPreviewLaunchService({
    isAvailable: isLocalBuildPreviewAvailable,
    loadTarget,
    activateTarget,
    prepareRuntime,
    async prepareEditablePreview(target) {
      const result =
        await defaultBuildEditablePreviewSessionService.beginRevision({
          buildRunId: target.buildRunId,
          draftRevisionId: target.revisionId,
          persistPreviewUrl: false,
        });
      if (result.kind !== 'ready') {
        throw new Error(
          result.kind === 'failed'
            ? result.reason
            : `Studio returned ${result.kind}.`
        );
      }
      return { previewUrl: result.previewUrl };
    },
    runPreview,
    finalizeLease,
    reportError,
  });
