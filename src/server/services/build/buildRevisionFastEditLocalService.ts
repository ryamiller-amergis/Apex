import { createHash } from 'node:crypto';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/drizzle';
import {
  buildLogoCandidates,
  buildRevisionFastEditAttempts,
  buildRevisions,
  buildRuns,
} from '../../db/schema';
import { git, safeArgs } from '../../utils/asyncGit';
import { appendBuildEvent } from '../buildEventsService';
import { checkoutDefaultBranch, getWorkspaceDir } from '../repoCheckoutService';
import { removeDirectoryAsync } from '../repoWorkspaceService';
import { WORKTREE_GIT_TIMEOUT_MS } from '../repoGitSettings';
import {
  classifyBuildRevisionFastEdit,
  formatEscalationTimelineMessage,
} from './buildRevisionFastEditClassifier';
import { localCursorRevisionEditAgentProvider } from './buildRevisionEditAgent';
import {
  localBuildRevisionFastEditArtifactStore,
  type FastEditWorkspaceChange,
} from './buildRevisionFastEditArtifactStore';
import { buildRevisionFastEditRepository } from './buildRevisionFastEditRepository';
import {
  createBuildRevisionFastEditService,
  type BuildRevisionFastEditTarget,
} from './buildRevisionFastEditService';
import { defaultBuildEditablePreviewSessionService } from './buildEditablePreviewLocalService';
import { markValidated } from './finalCheck';
import { createLogoCandidateFileStore } from './buildLogoCandidateService';

const FAST_EDIT_WORKSPACE_PREFIX = 'build-fast-edit-';
const FAST_EDIT_TTL_MS = 2 * 60 * 60 * 1_000;
const activeEditControllers = new Map<string, AbortController>();

export async function cancelBuildRevisionFastEdit(
  buildRunId: string
): Promise<void> {
  activeEditControllers
    .get(buildRunId)
    ?.abort(new Error('Fast revision cancelled.'));
  const now = new Date().toISOString();
  await db
    .update(buildRevisionFastEditAttempts)
    .set({
      status: 'superseded',
      failureCode: 'cancelled',
      failureMessage: 'The build was cancelled.',
      recordVersion: sql`${buildRevisionFastEditAttempts.recordVersion} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(buildRevisionFastEditAttempts.buildRunId, buildRunId),
        inArray(buildRevisionFastEditAttempts.status, [
          'classify',
          'edit',
          'apply',
          'checking',
          'rollback',
        ])
      )
    );
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function loadTarget(input: {
  buildRunId: string;
  buildRevisionId: string;
}): Promise<BuildRevisionFastEditTarget | null> {
  const [draft] = await db
    .select()
    .from(buildRevisions)
    .where(
      and(
        eq(buildRevisions.id, input.buildRevisionId),
        eq(buildRevisions.buildRunId, input.buildRunId)
      )
    )
    .limit(1);
  if (!draft?.feedback || draft.revisionNumber < 2) return null;

  const [[run], [base]] = await Promise.all([
    db
      .select()
      .from(buildRuns)
      .where(eq(buildRuns.id, input.buildRunId))
      .limit(1),
    db
      .select()
      .from(buildRevisions)
      .where(
        and(
          eq(buildRevisions.buildRunId, input.buildRunId),
          eq(buildRevisions.revisionNumber, draft.revisionNumber - 1)
        )
      )
      .limit(1),
  ]);
  if (!run || !base?.validatedCommit) return null;

  const requestedAt = draft.createdAt;
  return {
    buildRunId: run.id,
    buildRevisionId: draft.id,
    revisionNumber: draft.revisionNumber,
    feedback: draft.feedback,
    project: run.project,
    repository: run.repository,
    integrationBranch: run.integrationBranch ?? `apex/build/${run.id}`,
    approvedLogoCandidateId: draft.approvedLogoCandidateId,
    idempotencyKey: `${draft.id}:fast-edit`,
    requestDigest: digest(draft.feedback),
    baseCommit: base.validatedCommit,
    baseSnapshot: {
      digest: digest(`${run.repository}\0${base.validatedCommit}`),
      ref: `git:commit:${base.validatedCommit}`,
    },
    expectedWorkspaceVersion: 0,
    requestedAt,
    expiresAt: new Date(
      new Date(requestedAt).getTime() + FAST_EDIT_TTL_MS
    ).toISOString(),
  };
}

async function prepareWorkspace(target: BuildRevisionFastEditTarget) {
  const sessionId = `${FAST_EDIT_WORKSPACE_PREFIX}${target.buildRevisionId}`;
  const materializedPath = await checkoutDefaultBranch({
    project: target.project,
    repo: target.repository,
    branch: target.integrationBranch,
    sessionId,
    provider: 'ado',
  });
  // Cursor's repository tools honor the parent workspace's .cursorignore,
  // which excludes data/. Move this disposable checkout outside the Apex repo
  // so the edit agent can read and update it.
  const workspaceRoot = path.join(os.tmpdir(), 'apex-build-fast-edit');
  const workspacePath = path.join(workspaceRoot, target.buildRevisionId);
  await mkdir(workspaceRoot, { recursive: true });
  await rm(workspacePath, { recursive: true, force: true });
  await rename(materializedPath, workspacePath);
  await git(
    safeArgs(workspacePath, ['checkout', '--detach', target.baseCommit]),
    { cwd: workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS }
  );
  const head = (
    await git(safeArgs(workspacePath, ['rev-parse', 'HEAD']), {
      cwd: workspacePath,
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    })
  ).trim();
  if (head !== target.baseCommit) {
    throw new Error('Fast-edit workspace did not open at the base commit.');
  }
  return {
    workspacePath,
    release: async () => {
      await Promise.all([
        removeDirectoryAsync(workspacePath),
        removeDirectoryAsync(getWorkspaceDir(sessionId)),
      ]);
    },
  };
}

export async function restoreFastEditPathsToBase(input: {
  workspacePath: string;
  baseCommit: string;
  paths: string[];
}): Promise<FastEditWorkspaceChange[]> {
  return Promise.all(
    input.paths.map(async (relativePath) => {
      try {
        await git(
          safeArgs(input.workspacePath, [
            'cat-file',
            '-e',
            `${input.baseCommit}:${relativePath}`,
          ]),
          {
            cwd: input.workspacePath,
            timeout: WORKTREE_GIT_TIMEOUT_MS,
          }
        );
        await git(
          safeArgs(input.workspacePath, [
            'checkout',
            input.baseCommit,
            '--',
            relativePath,
          ]),
          {
            cwd: input.workspacePath,
            timeout: WORKTREE_GIT_TIMEOUT_MS,
          }
        );
        return { status: 'M' as const, relativePath };
      } catch {
        await rm(path.join(input.workspacePath, ...relativePath.split('/')), {
          recursive: true,
          force: true,
        });
        return { status: 'D' as const, relativePath };
      }
    })
  );
}

async function checkpoint(input: {
  target: BuildRevisionFastEditTarget;
  workspacePath: string;
}): Promise<string> {
  await git(safeArgs(input.workspacePath, ['add', '--all']), {
    cwd: input.workspacePath,
    timeout: WORKTREE_GIT_TIMEOUT_MS,
  });
  await git(
    safeArgs(input.workspacePath, [
      '-c',
      'user.name=Apex Build',
      '-c',
      'user.email=apex-build@local',
      'commit',
      '-m',
      `Apex fast revision ${input.target.revisionNumber}`,
    ]),
    { cwd: input.workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS }
  );
  const commit = (
    await git(safeArgs(input.workspacePath, ['rev-parse', 'HEAD']), {
      cwd: input.workspacePath,
      timeout: WORKTREE_GIT_TIMEOUT_MS,
    })
  ).trim();
  await git(
    safeArgs(input.workspacePath, [
      'push',
      'origin',
      `${commit}:refs/heads/${input.target.integrationBranch}`,
    ]),
    { cwd: input.workspacePath, timeout: WORKTREE_GIT_TIMEOUT_MS }
  );
  return commit;
}

async function markFastEditExecutionFailed({
  target,
}: {
  target: BuildRevisionFastEditTarget;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(buildRuns)
    .set({ status: 'preview_ready', updatedAt: now })
    .where(
      and(
        eq(buildRuns.id, target.buildRunId),
        inArray(buildRuns.status, ['building', 'checking'])
      )
    );
  await appendBuildEvent({
    buildRunId: target.buildRunId,
    buildRevisionId: target.buildRevisionId,
    eventType: 'revision.fast_edit_failed',
    severity: 'warn',
    message: 'The preview update could not be completed.',
    detail: { revisionNumber: target.revisionNumber },
  });
}

/**
 * Continues a revision on the repository cloud agent, which starts from the
 * integration branch and receives the requester's feedback in its prompt.
 */
export async function handOffRevisionToCloudAgent(input: {
  target: BuildRevisionFastEditTarget;
  reason: string;
}): Promise<void> {
  const { target } = input;
  // The cloud agent cannot read a logo stored on this server.
  if (target.approvedLogoCandidateId) {
    await markFastEditExecutionFailed({ target });
    return;
  }
  const [run] = await db
    .select({
      status: buildRuns.status,
      currentRevisionNumber: buildRuns.currentRevisionNumber,
    })
    .from(buildRuns)
    .where(eq(buildRuns.id, target.buildRunId))
    .limit(1);
  if (
    !run ||
    run.currentRevisionNumber !== target.revisionNumber ||
    !['building', 'checking', 'preview_ready'].includes(run.status)
  ) {
    return;
  }
  await appendBuildEvent({
    buildRunId: target.buildRunId,
    buildRevisionId: target.buildRevisionId,
    eventType: 'revision.cloud_handoff',
    message:
      'The quick preview edit could not finish here, so a cloud agent is making this change on the current code.',
    detail: {
      revisionNumber: target.revisionNumber,
      reason: input.reason.slice(0, 500),
    },
    dedupeKey: `revision-cloud-handoff:${target.buildRevisionId}`,
  });
  try {
    const { startSingleAgentBuild } = await import(
      '../buildOrchestrator/singleAgentBuild'
    );
    await startSingleAgentBuild(target.buildRunId);
  } catch (error) {
    await appendBuildEvent({
      buildRunId: target.buildRunId,
      buildRevisionId: target.buildRevisionId,
      eventType: 'revision.cloud_handoff_failed',
      severity: 'error',
      message: 'The cloud agent could not start this change. Send it again to retry.',
      detail: {
        revisionNumber: target.revisionNumber,
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          500
        ),
      },
    });
    await markFastEditExecutionFailed({ target });
  }
}

export const defaultBuildRevisionFastEditService =
  createBuildRevisionFastEditService({
    repository: buildRevisionFastEditRepository,
    loadTarget,
    classify: classifyBuildRevisionFastEdit,
    beginStudio: (input) =>
      defaultBuildEditablePreviewSessionService.beginRevision(input),
    async prepareWorkspace(target) {
      await appendBuildEvent({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
        eventType: 'revision.fast_edit_editing',
        message: 'Inspecting UI components and applying your visual update.',
        detail: { revisionNumber: target.revisionNumber },
      });
      return prepareWorkspace(target);
    },
    async restoreWorkspace({ workspacePath, recovery }) {
      for (const changeSet of recovery.orderedChangeSets) {
        const resolved = await localBuildRevisionFastEditArtifactStore.resolve(
          changeSet.artifact
        );
        for (const relativePath of resolved.deletePaths) {
          await rm(path.join(workspacePath, ...relativePath.split('/')), {
            recursive: true,
            force: true,
          });
        }
        for (const relativePath of resolved.changedPaths) {
          const destination = path.join(
            workspacePath,
            ...relativePath.split('/')
          );
          await mkdir(path.dirname(destination), { recursive: true });
          await copyFile(
            path.join(resolved.localPath, 'files', ...relativePath.split('/')),
            destination
          );
        }
      }
    },
    async materializeRollback({ workspacePath, target, recovery }) {
      const affectedPaths = new Set<string>();
      for (const changeSet of recovery.orderedChangeSets) {
        const resolved = await localBuildRevisionFastEditArtifactStore.resolve(
          changeSet.artifact
        );
        for (const relativePath of [
          ...resolved.changedPaths,
          ...resolved.deletePaths,
        ]) {
          affectedPaths.add(relativePath);
        }
      }
      const changes = await restoreFastEditPathsToBase({
        workspacePath,
        baseCommit: target.baseCommit,
        paths: [...affectedPaths],
      });
      return localBuildRevisionFastEditArtifactStore.materialize({
        workspacePath,
        baseCommit: target.baseCommit,
        changes,
      });
    },
    editAgent: {
      async edit(input) {
        const buildRunId = input.buildRunId;
        if (!buildRunId) {
          return localCursorRevisionEditAgentProvider.edit(input);
        }
        const controller = new AbortController();
        activeEditControllers
          .get(buildRunId)
          ?.abort(new Error('A newer fast revision replaced this edit.'));
        activeEditControllers.set(buildRunId, controller);
        try {
          return await localCursorRevisionEditAgentProvider.edit({
            ...input,
            signal: controller.signal,
          });
        } finally {
          if (activeEditControllers.get(buildRunId) === controller) {
            activeEditControllers.delete(buildRunId);
          }
        }
      },
    },
    async stageApprovedAssets({ target, workspacePath }) {
      if (!target.approvedLogoCandidateId) return;
      const [candidate] = await db
        .select({
          storageKey: buildLogoCandidates.storageKey,
        })
        .from(buildLogoCandidates)
        .where(
          and(
            eq(buildLogoCandidates.id, target.approvedLogoCandidateId),
            eq(buildLogoCandidates.buildRunId, target.buildRunId),
            eq(buildLogoCandidates.status, 'approved')
          )
        )
        .limit(1);
      if (!candidate?.storageKey) {
        throw new Error('The approved logo asset is unavailable.');
      }
      const bytes = await createLogoCandidateFileStore().read(
        candidate.storageKey
      );
      if (!bytes) {
        throw new Error('The approved logo asset is unavailable.');
      }
      const destination = path.join(
        workspacePath,
        'apps',
        'web',
        'public',
        'brand',
        'logo.png'
      );
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    },
    artifactStore: localBuildRevisionFastEditArtifactStore,
    applyDraft: (input) =>
      defaultBuildEditablePreviewSessionService.applyDraftChangeSet(input),
    async runChecks(input) {
      await appendBuildEvent({
        buildRunId: input.buildRunId,
        buildRevisionId: input.draftRevisionId,
        eventType: 'revision.fast_edit_checking',
        message: 'Preview updated — running quick checks.',
        detail: { workspaceVersion: input.workspaceVersion },
      });
      return defaultBuildEditablePreviewSessionService.runDraftChecks(input);
    },
    checkpoint,
    markValidated,
    async markRetryStarted({ buildRunId }) {
      await db
        .update(buildRuns)
        .set({ status: 'building', updatedAt: new Date().toISOString() })
        .where(
          and(
            eq(buildRuns.id, buildRunId),
            eq(buildRuns.status, 'preview_ready')
          )
        );
    },
    async markChecksFailed({ target, summary }) {
      const now = new Date().toISOString();
      await db
        .update(buildRuns)
        .set({ status: 'preview_ready', updatedAt: now })
        .where(
          and(
            eq(buildRuns.id, target.buildRunId),
            inArray(buildRuns.status, ['building', 'checking'])
          )
        );
      await appendBuildEvent({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
        eventType: 'revision.fast_edit_checks_failed',
        severity: 'warn',
        message: 'The preview was updated, but checks failed.',
        detail: {
          revisionNumber: target.revisionNumber,
          checkStatus: summary.status,
        },
      });
    },
    markExecutionFailed: markFastEditExecutionFailed,
    async escalate({ target, reason }) {
      await appendBuildEvent({
        buildRunId: target.buildRunId,
        buildRevisionId: target.buildRevisionId,
        eventType: 'revision.fast_edit_escalated',
        message: formatEscalationTimelineMessage(reason),
        detail: {
          revisionNumber: target.revisionNumber,
          reason: reason.slice(0, 500),
        },
      });
      await handOffRevisionToCloudAgent({ target, reason });
    },
    handOffToCloud: handOffRevisionToCloudAgent,
  });
