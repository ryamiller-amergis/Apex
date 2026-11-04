/**
 * Merges finished task branches into a build's integration branch via short-lived
 * Azure DevOps pull requests (FEAT-012, TBI-022 / S4).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  BuildRunStatus,
  BuildTaskStatus,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import { appendBuildEvent } from '../buildEventsService';
import { redactText } from '../buildRedactionService';
import { trackEvent } from '../telemetry';

const MERGE_DEADLINE_MS = 30_000;
const INITIAL_POLL_MS = 250;
const MAX_POLL_MS = 2_000;

export type MergeOutcome =
  | { outcome: 'merged'; mergeCommit: string; prUrl: string }
  | { outcome: 'already_merged' }
  | { outcome: 'conflict'; prUrl: string }
  | { outcome: 'pending' }
  | { outcome: 'blocked_by_policy'; branch: string }
  | { outcome: 'source_missing' }
  | { outcome: 'skipped_run_inactive' };

export interface MergeTaskInfo {
  id: string;
  revisionId: string;
  taskKey: string;
  status: BuildTaskStatus;
  attempt: number;
  branchName: string | null;
  covers: string[];
  chainHeadKey: string | null;
}

export interface MergeRunInfo {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  integrationBranch: string | null;
}

export interface MergeAdoPort {
  getBranchHeadCommit(
    repo: string,
    project: string,
    branch: string
  ): Promise<string | null>;
  findPullRequestBySourceBranch(
    repo: string,
    project: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<{
    pullRequestId: number;
    status: 'active' | 'completed' | 'abandoned';
  } | null>;
  createPullRequest(opts: {
    repo: string;
    project: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    deleteSourceBranch?: boolean;
  }): Promise<{ pullRequestId: number; prUrl: string }>;
  getPullRequest(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
  }): Promise<{
    status: 'active' | 'completed' | 'abandoned';
    mergeStatus:
      | 'notSet'
      | 'queued'
      | 'conflicts'
      | 'succeeded'
      | 'rejectedByPolicy'
      | 'failure';
    sourceCommit: string | null;
    mergeCommit: string | null;
  }>;
  completePullRequest(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
    sourceCommit: string;
    deleteSourceBranch: boolean;
    mergeStrategy: 'noFastForward';
  }): Promise<void>;
  abandonPullRequest(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
  }): Promise<void>;
}

export interface MergeDeps {
  withRevisionMergeLock: <T>(
    revisionId: string,
    fn: () => Promise<T>
  ) => Promise<T>;
  loadTaskAndRun: (taskId: string) => Promise<{
    task: MergeTaskInfo;
    siblingTaskIdsOnBranch: string[];
    run: MergeRunInfo;
  } | null>;
  markTasksMerged: (
    taskIds: string[],
    pullRequestId: number,
    mergeCommit: string | null
  ) => Promise<void>;
  markTasksFailed: (taskIds: string[]) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
    correlation?: { kind: 'pull_request' | 'commit'; id: string };
    dedupeKey?: string;
  }) => Promise<void>;
  ado: MergeAdoPort;
  deleteSourceBranch?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  trackDuration?: (durationMs: number, props: Record<string, string>) => void;
}

const INACTIVE_RUN_STATUSES: ReadonlySet<BuildRunStatus> = new Set([
  'suspended',
  'cancelled',
  'failed',
  'accepted',
]);

function extractPrIdFromUrl(prUrl: string): number {
  const match = prUrl.match(/\/pullrequest\/(\d+)$/i);
  const id = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Could not parse pullRequestId from URL: ${prUrl}`);
  }
  return id;
}

function buildPrUrl(
  project: string,
  repo: string,
  pullRequestId: number
): string {
  const org = (process.env.ADO_ORG ?? 'https://dev.azure.com/org').replace(
    /\/$/,
    ''
  );
  return `${org}/${project}/_git/${repo}/pullrequest/${pullRequestId}`;
}

function createDefaultMergeDeps(): MergeDeps {
  return {
    async withRevisionMergeLock(revisionId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`build-merge:${revisionId}`}))`
        );
        return fn();
      });
    },
    async loadTaskAndRun(taskId) {
      const [row] = await db
        .select({
          task: buildTasks,
          run: buildRuns,
        })
        .from(buildTasks)
        .innerJoin(
          buildRevisions,
          eq(buildRevisions.id, buildTasks.buildRevisionId)
        )
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildTasks.id, taskId));
      if (!row) return null;

      let siblingTaskIdsOnBranch = [row.task.id];
      if (row.task.branchName) {
        const siblings = await db
          .select({ id: buildTasks.id })
          .from(buildTasks)
          .where(
            and(
              eq(buildTasks.buildRevisionId, row.task.buildRevisionId),
              eq(buildTasks.branchName, row.task.branchName)
            )
          );
        if (siblings.length > 0) {
          siblingTaskIdsOnBranch = siblings.map((s) => s.id);
        }
      } else if (row.task.chainHeadKey) {
        const siblings = await db
          .select({ id: buildTasks.id })
          .from(buildTasks)
          .where(
            and(
              eq(buildTasks.buildRevisionId, row.task.buildRevisionId),
              eq(buildTasks.chainHeadKey, row.task.chainHeadKey)
            )
          );
        if (siblings.length > 0) {
          siblingTaskIdsOnBranch = siblings.map((s) => s.id);
        }
      }

      return {
        task: {
          id: row.task.id,
          revisionId: row.task.buildRevisionId,
          taskKey: row.task.taskKey,
          status: row.task.status,
          attempt: row.task.attempt,
          branchName: row.task.branchName ?? null,
          covers: row.task.covers ?? [],
          chainHeadKey: row.task.chainHeadKey ?? null,
        },
        siblingTaskIdsOnBranch,
        run: {
          id: row.run.id,
          project: row.run.project,
          repository: row.run.repository,
          status: row.run.status,
          integrationBranch: row.run.integrationBranch ?? null,
        },
      };
    },
    async markTasksMerged(taskIds, pullRequestId, mergeCommit) {
      if (taskIds.length === 0) return;
      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx
          .update(buildTasks)
          .set({
            status: 'merged',
            mergePullRequestId: pullRequestId,
            mergeCommit: mergeCommit ?? null,
            completedAt: now,
            updatedAt: now,
          })
          .where(inArray(buildTasks.id, taskIds));
      });
    },
    async markTasksFailed(taskIds) {
      if (taskIds.length === 0) return;
      const now = new Date().toISOString();
      await db
        .update(buildTasks)
        .set({
          status: 'failed',
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(inArray(buildTasks.id, taskIds), eq(buildTasks.status, 'running'))
        );
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
    ado: {
      async getBranchHeadCommit(repo, project, branch) {
        const svc = new AzureDevOpsService(project);
        return svc.getBranchHeadCommit(repo, project, branch);
      },
      async findPullRequestBySourceBranch(
        repo,
        project,
        sourceBranch,
        targetBranch
      ) {
        const svc = new AzureDevOpsService(project);
        return svc.findPullRequestBySourceBranch(
          repo,
          project,
          sourceBranch,
          targetBranch
        );
      },
      async createPullRequest(opts) {
        const svc = new AzureDevOpsService(opts.project);
        const prUrl = await svc.createPullRequest({
          repo: opts.repo,
          project: opts.project,
          sourceBranch: opts.sourceBranch,
          targetBranch: opts.targetBranch,
          title: opts.title,
          description: opts.description,
          isDraft: false,
        });
        return { pullRequestId: extractPrIdFromUrl(prUrl), prUrl };
      },
      async getPullRequest(opts) {
        const svc = new AzureDevOpsService(opts.project);
        return svc.getPullRequest(opts);
      },
      async completePullRequest(opts) {
        const svc = new AzureDevOpsService(opts.project);
        await svc.completePullRequest(opts);
      },
      async abandonPullRequest(opts) {
        const svc = new AzureDevOpsService(opts.project);
        await svc.abandonPullRequest(opts);
      },
    },
    deleteSourceBranch: true,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    trackDuration: (durationMs, props) => {
      trackEvent('build_merge_duration_ms', props, { durationMs });
    },
  };
}

export async function mergeTaskBranch(
  taskId: string,
  deps?: MergeDeps
): Promise<MergeOutcome> {
  const resolved = deps ?? createDefaultMergeDeps();
  const now = resolved.now ?? Date.now;
  const sleep =
    resolved.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deleteSourceBranch = resolved.deleteSourceBranch ?? true;

  const initial = await resolved.loadTaskAndRun(taskId);
  if (!initial) {
    return { outcome: 'skipped_run_inactive' };
  }

  return resolved.withRevisionMergeLock(initial.task.revisionId, async () => {
    const startedMs = now();
    const loaded = await resolved.loadTaskAndRun(taskId);
    if (!loaded) {
      return { outcome: 'skipped_run_inactive' };
    }

    const { task, siblingTaskIdsOnBranch, run } = loaded;
    if (task.status === 'merged') {
      return { outcome: 'already_merged' };
    }
    if (INACTIVE_RUN_STATUSES.has(run.status)) {
      await resolved.appendEvent({
        buildRunId: run.id,
        buildRevisionId: task.revisionId,
        eventType: 'merge.skipped',
        message: `Skipped merging task ${task.taskKey} because the build run is ${run.status}.`,
        detail: { taskKey: task.taskKey, runStatus: run.status },
      });
      return { outcome: 'skipped_run_inactive' };
    }

    const sourceBranch = task.branchName;
    const targetBranch = run.integrationBranch;
    if (!sourceBranch || !targetBranch) {
      await resolved.markTasksFailed(siblingTaskIdsOnBranch);
      return { outcome: 'source_missing' };
    }

    // Step 2: Check for an existing pull request (including completed for crash recovery)
    const existing = await resolved.ado.findPullRequestBySourceBranch(
      run.repository,
      run.project,
      sourceBranch,
      targetBranch
    );

    if (existing?.status === 'completed') {
      const prDetail = await resolved.ado.getPullRequest({
        repo: run.repository,
        project: run.project,
        pullRequestId: existing.pullRequestId,
      });
      const mergeCommit =
        prDetail.mergeCommit ?? prDetail.sourceCommit ?? 'merged';
      const prUrl = buildPrUrl(
        run.project,
        run.repository,
        existing.pullRequestId
      );
      await resolved.markTasksMerged(
        siblingTaskIdsOnBranch,
        existing.pullRequestId,
        mergeCommit
      );
      await resolved.appendEvent({
        buildRunId: run.id,
        buildRevisionId: task.revisionId,
        eventType: 'merge.completed',
        message: `Merged task ${task.taskKey} into ${targetBranch}.`,
        detail: {
          taskKey: task.taskKey,
          pullRequestId: existing.pullRequestId,
          mergeCommit,
        },
        correlation: {
          kind: 'pull_request',
          id: String(existing.pullRequestId),
        },
        dedupeKey: `merge.completed:${task.id}:${task.attempt}`,
      });
      return { outcome: 'merged', mergeCommit, prUrl };
    }

    let pullRequestId: number;
    let prUrl: string;

    if (existing?.status === 'active') {
      pullRequestId = existing.pullRequestId;
      prUrl = buildPrUrl(run.project, run.repository, pullRequestId);
    } else {
      const sourceHead = await resolved.ado.getBranchHeadCommit(
        run.repository,
        run.project,
        sourceBranch
      );
      if (!sourceHead) {
        await resolved.markTasksFailed(siblingTaskIdsOnBranch);
        return { outcome: 'source_missing' };
      }

      const runShortId = run.id.slice(0, 8);
      const rawTitle = `Build ${runShortId} · ${task.taskKey} (attempt ${task.attempt})`;
      const rawDescription =
        task.covers.length > 0
          ? `Covers requirements: ${task.covers.join(', ')}`
          : `Task ${task.taskKey} (attempt ${task.attempt})`;

      const created = await resolved.ado.createPullRequest({
        repo: run.repository,
        project: run.project,
        sourceBranch,
        targetBranch,
        title: redactText(rawTitle),
        description: redactText(rawDescription),
        deleteSourceBranch,
      });
      pullRequestId = created.pullRequestId;
      prUrl = created.prUrl;

      await resolved.appendEvent({
        buildRunId: run.id,
        buildRevisionId: task.revisionId,
        eventType: 'merge.started',
        message: `Started merging task ${task.taskKey} into ${targetBranch}.`,
        detail: { taskKey: task.taskKey, pullRequestId },
        correlation: { kind: 'pull_request', id: String(pullRequestId) },
        dedupeKey: `merge.started:${task.id}:${task.attempt}`,
      });
    }

    // Step 4: Poll getPullRequest until mergeStatus leaves 'queued' / 'notSet', up to 30s
    let delayMs = INITIAL_POLL_MS;
    let prState = await resolved.ado.getPullRequest({
      repo: run.repository,
      project: run.project,
      pullRequestId,
    });

    while (
      (prState.mergeStatus === 'queued' || prState.mergeStatus === 'notSet') &&
      prState.status !== 'completed'
    ) {
      if (now() - startedMs >= MERGE_DEADLINE_MS) {
        await resolved.appendEvent({
          buildRunId: run.id,
          buildRevisionId: task.revisionId,
          eventType: 'merge.pending',
          message: `Merge for task ${task.taskKey} is still being computed by Azure DevOps.`,
          detail: { taskKey: task.taskKey, pullRequestId },
          correlation: { kind: 'pull_request', id: String(pullRequestId) },
        });
        return { outcome: 'pending' };
      }
      await sleep(delayMs);
      delayMs = Math.min(MAX_POLL_MS, delayMs * 2);
      prState = await resolved.ado.getPullRequest({
        repo: run.repository,
        project: run.project,
        pullRequestId,
      });
    }

    if (prState.mergeStatus === 'conflicts') {
      await resolved.ado.abandonPullRequest({
        repo: run.repository,
        project: run.project,
        pullRequestId,
      });
      await resolved.markTasksFailed(siblingTaskIdsOnBranch);
      await resolved.appendEvent({
        buildRunId: run.id,
        buildRevisionId: task.revisionId,
        eventType: 'merge.conflict',
        severity: 'warn',
        message: `Task ${task.taskKey} had a merge conflict with ${targetBranch}.`,
        detail: { taskKey: task.taskKey, pullRequestId, prUrl },
        correlation: { kind: 'pull_request', id: String(pullRequestId) },
        dedupeKey: `merge.conflict:${task.id}:${task.attempt}`,
      });
      return { outcome: 'conflict', prUrl };
    }

    if (prState.mergeStatus === 'rejectedByPolicy') {
      await resolved.ado.abandonPullRequest({
        repo: run.repository,
        project: run.project,
        pullRequestId,
      });
      await resolved.appendEvent({
        buildRunId: run.id,
        buildRevisionId: task.revisionId,
        eventType: 'merge.blocked_by_policy',
        severity: 'error',
        message: `Branch policy on ${targetBranch} blocked merging task ${task.taskKey}.`,
        detail: { taskKey: task.taskKey, branch: targetBranch, pullRequestId },
        correlation: { kind: 'pull_request', id: String(pullRequestId) },
      });
      return { outcome: 'blocked_by_policy', branch: targetBranch };
    }

    if (prState.mergeStatus === 'failure') {
      throw new Error(
        `Azure DevOps reported merge failure for PR ${pullRequestId}`
      );
    }

    // Step 6: Complete PR and poll until status === 'completed'
    if (prState.status !== 'completed') {
      await resolved.ado.completePullRequest({
        repo: run.repository,
        project: run.project,
        pullRequestId,
        sourceCommit: prState.sourceCommit ?? '',
        deleteSourceBranch,
        mergeStrategy: 'noFastForward',
      });

      delayMs = INITIAL_POLL_MS;
      for (;;) {
        if (now() - startedMs >= MERGE_DEADLINE_MS) {
          await resolved.appendEvent({
            buildRunId: run.id,
            buildRevisionId: task.revisionId,
            eventType: 'merge.pending',
            message: `Pull request completion for task ${task.taskKey} is still in progress.`,
            detail: { taskKey: task.taskKey, pullRequestId },
            correlation: { kind: 'pull_request', id: String(pullRequestId) },
          });
          return { outcome: 'pending' };
        }
        prState = await resolved.ado.getPullRequest({
          repo: run.repository,
          project: run.project,
          pullRequestId,
        });
        if (prState.status === 'completed') break;
        await sleep(delayMs);
        delayMs = Math.min(MAX_POLL_MS, delayMs * 2);
      }
    }

    const mergeCommit = prState.mergeCommit ?? prState.sourceCommit ?? 'merged';
    await resolved.markTasksMerged(
      siblingTaskIdsOnBranch,
      pullRequestId,
      mergeCommit
    );
    await resolved.appendEvent({
      buildRunId: run.id,
      buildRevisionId: task.revisionId,
      eventType: 'merge.completed',
      message: `Merged task ${task.taskKey} into ${targetBranch}.`,
      detail: { taskKey: task.taskKey, pullRequestId, mergeCommit },
      correlation: { kind: 'pull_request', id: String(pullRequestId) },
      dedupeKey: `merge.completed:${task.id}:${task.attempt}`,
    });
    resolved.trackDuration?.(now() - startedMs, {
      buildRunId: run.id,
      revisionId: task.revisionId,
      taskKey: task.taskKey,
    });

    return { outcome: 'merged', mergeCommit, prUrl };
  });
}
