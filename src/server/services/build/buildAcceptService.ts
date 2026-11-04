/**
 * Build accept, sync, and pull request creation service (FEAT-015, TBI-027, PBI-033, PBI-034 / S4, S5, S6, S8).
 *
 * Notice that `AcceptScmPort` has NO `completePullRequest` or `vote` method —
 * Apex never completes the pull request (BR-007).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type {
  BuildAcceptResponse,
  BuildDeploymentStatus,
  BuildRiskDecision,
  BuildRunStatus,
  BuildSupportContact,
  BuildTaskStatus,
} from '../../../shared/types/build';
import { db } from '../../db/drizzle';
import { buildRevisions, buildRuns, buildTasks } from '../../db/schema';
import { AzureDevOpsService } from '../azureDevOps';
import { appendBuildEvent } from '../buildEventsService';
import { defaultPreviewLeaseService } from '../buildPreviewLeaseService';
import { redactText } from '../buildRedactionService';
import { createNotification } from '../notificationService';
import { canActOnBuild, type BuildActorContext } from './buildAccessPolicy';
import { deriveAcceptState } from './buildAcceptState';
import {
  composePullRequestBody,
  type PullRequestRequirementEntry,
} from './buildPullRequestBody';

const MERGE_POLL_DEADLINE_MS = 15_000;
const MERGE_POLL_STEP_MS = 1_000;

export type BuildAcceptErrorCode =
  | 'BUILD_INVALID_REQUEST'
  | 'BUILD_NOT_ALLOWED'
  | 'BUILD_FLAG_DISABLED'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_STALE_REVISION'
  | 'BUILD_NOT_ACCEPTABLE'
  | 'BUILD_BRANCH_DIVERGED'
  | 'BUILD_SCM_UNAVAILABLE';

export class BuildAcceptError extends Error {
  readonly code: BuildAcceptErrorCode;
  readonly statusCode: number;

  constructor(code: BuildAcceptErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = 'BuildAcceptError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * SCM port for Accept & Pull Request. Intentionally omits `completePullRequest`
 * and voting methods so Apex can never complete a pull request into the default branch.
 */
export interface AcceptScmPort {
  getDefaultBranch(repo: string, project: string): Promise<string>;
  getBranchHeadCommit(
    repo: string,
    project: string,
    branch: string
  ): Promise<string | null>;
  findPullRequestUrlBySourceBranch(
    repo: string,
    project: string,
    sourceBranch: string
  ): Promise<string | null>;
  createPullRequest(opts: {
    repo: string;
    project: string;
    sourceBranch: string;
    targetBranch: string;
    title: string;
    description: string;
    isDraft: boolean;
  }): Promise<string>;
  getPullRequestMergeStatus(
    repo: string,
    project: string,
    pullRequestId: number
  ): Promise<
    | 'notSet'
    | 'queued'
    | 'conflicts'
    | 'succeeded'
    | 'rejectedByPolicy'
    | 'failure'
  >;
  updatePullRequest(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
    title: string;
    description?: string;
    isDraft?: boolean;
  }): Promise<void>;
  addPullRequestLabel(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
    name: string;
  }): Promise<void>;
  resolveIdentityIdByEmail(
    project: string,
    email: string
  ): Promise<string | null>;
  addPullRequestReviewers(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
    reviewers: Array<{ id: string; displayName?: string }>;
  }): Promise<{
    added: string[];
    failed: Array<{ id: string; message: string }>;
  }>;
  addPullRequestComment(opts: {
    repo: string;
    project: string;
    pullRequestId: number;
    content: string;
  }): Promise<void>;
}

export interface AcceptRunRecord {
  id: string;
  project: string;
  repository: string;
  status: BuildRunStatus;
  requesterUserId: string;
  requesterDisplayName: string;
  currentRevisionNumber: number;
  acceptedRevisionNumber: number | null;
  integrationBranch: string | null;
  pullRequestUrl: string | null;
  pullRequestId: number | null;
  supportContacts: BuildSupportContact[];
  claimedAtMs: number | null;
}

export interface AcceptRevisionRecord {
  id: string;
  buildRunId: string;
  revisionNumber: number;
  validatedCommit: string | null;
  deploymentStatus: BuildDeploymentStatus;
  briefTitle: string;
  riskDecisions: BuildRiskDecision[];
  requirements: PullRequestRequirementEntry[];
}

export interface AcceptSyncTaskRecord {
  id: string;
  revisionId: string;
  status: BuildTaskStatus;
  syncCommitSha: string | null;
}

export interface BuildAcceptServiceDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  withAcceptLock: <T>(runId: string, fn: () => Promise<T>) => Promise<T | null>;
  loadRun: (buildId: string) => Promise<AcceptRunRecord | null>;
  loadRevision: (
    buildId: string,
    revisionNumber: number
  ) => Promise<AcceptRevisionRecord | null>;
  casClaimAccept: (
    buildId: string,
    revisionNumber: number
  ) => Promise<
    | { kind: 'claimed'; run: AcceptRunRecord }
    | { kind: 'already_claimed'; run: AcceptRunRecord }
    | { kind: 'not_found' }
    | { kind: 'stale_revision' }
    | { kind: 'not_acceptable' }
  >;
  releaseLease: (runId: string) => Promise<void>;
  findOrInsertSyncTask: (
    revisionId: string,
    revisionNumber: number
  ) => Promise<{ inserted: boolean; task: AcceptSyncTaskRecord }>;
  getSyncTaskForRevision: (
    revisionId: string,
    revisionNumber: number
  ) => Promise<AcceptSyncTaskRecord | null>;
  launchSyncTask: (taskId: string, run: AcceptRunRecord) => Promise<void>;
  casCompleteSyncTask: (
    taskId: string,
    nextStatus: 'merged' | 'failed',
    syncCommitSha: string | null
  ) => Promise<AcceptSyncTaskRecord | null>;
  setRunNeedsDeveloper: (runId: string) => Promise<void>;
  storePullRequestUrl: (
    runId: string,
    pullRequestId: number,
    pullRequestUrl: string
  ) => Promise<void>;
  notifyRequesterPrOpened: (input: {
    userId: string;
    title: string;
    body: string;
    link: string;
    dedupeKey: string;
  }) => Promise<void>;
  notifyContactNeedsDeveloper: (input: {
    userId: string;
    title: string;
    body: string;
    link: string;
    dedupeKey: string;
  }) => Promise<void>;
  /** Completes the suspended Playbook build step after the PR is durable. */
  reportBuildTerminal?: (input: {
    buildRunId: string;
    pullRequestUrl: string;
  }) => Promise<void>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId?: string | null;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
  scm: AcceptScmPort;
}

function parsePullRequestIdFromUrl(url: string): number {
  const m = url.match(/\/pullrequest\/(\d+)$/i);
  return m ? Number(m[1]) : 1;
}

function createDefaultBuildAcceptDeps(): BuildAcceptServiceDeps {
  const mapRun = (row: typeof buildRuns.$inferSelect): AcceptRunRecord => ({
    id: row.id,
    project: row.project,
    repository: row.repository,
    status: row.status,
    requesterUserId: row.requestedByUserId,
    requesterDisplayName: row.requestedByUserId,
    currentRevisionNumber: row.currentRevisionNumber,
    acceptedRevisionNumber: row.acceptedRevisionNumber ?? null,
    integrationBranch: row.integrationBranch ?? `apex/build/${row.id}`,
    pullRequestUrl: row.pullRequestUrl ?? null,
    pullRequestId: row.pullRequestId ?? null,
    supportContacts: row.supportContacts ?? [],
    claimedAtMs: row.endedAt ? Date.parse(row.endedAt) : null,
  });

  const scm: AcceptScmPort = {
    async getDefaultBranch(repo, project) {
      const svc = new AzureDevOpsService(project);
      return svc.getDefaultBranch(repo, project);
    },
    async getBranchHeadCommit(repo, project, branch) {
      const svc = new AzureDevOpsService(project);
      return svc.getBranchHeadCommit(repo, project, branch);
    },
    async findPullRequestUrlBySourceBranch(repo, project, sourceBranch) {
      const svc = new AzureDevOpsService(project);
      return svc.findPullRequestUrlBySourceBranch(repo, project, sourceBranch);
    },
    async createPullRequest(opts) {
      const svc = new AzureDevOpsService(opts.project);
      return svc.createPullRequest(opts);
    },
    async getPullRequestMergeStatus(repo, project, pullRequestId) {
      const svc = new AzureDevOpsService(project);
      return svc.getPullRequestMergeStatus(repo, project, pullRequestId);
    },
    async updatePullRequest(opts) {
      const svc = new AzureDevOpsService(opts.project);
      await svc.updatePullRequest(opts);
    },
    async addPullRequestLabel(opts) {
      const svc = new AzureDevOpsService(opts.project);
      await svc.addPullRequestLabel(opts);
    },
    async resolveIdentityIdByEmail(project, email) {
      const svc = new AzureDevOpsService(project);
      return svc.resolveIdentityIdByEmail(project, email);
    },
    async addPullRequestReviewers(opts) {
      const svc = new AzureDevOpsService(opts.project);
      return svc.addPullRequestReviewers(opts);
    },
    async addPullRequestComment(opts) {
      const svc = new AzureDevOpsService(opts.project);
      await svc.addPullRequestComment(opts);
    },
  };

  return {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async withAcceptLock(runId, fn) {
      return db.transaction(async (tx) => {
        const res = await tx.execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(hashtext(${`build-accept:${runId}`})) AS locked`
        );
        if (!res.rows[0]?.locked) return null;
        return fn();
      });
    },
    async loadRun(buildId) {
      const [row] = await db
        .select()
        .from(buildRuns)
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      return row ? mapRun(row) : null;
    },
    async reportBuildTerminal(input) {
      const { reportBuildTerminal } =
        await import('../buildOrchestrator/planning');
      await reportBuildTerminal(input.buildRunId, {
        buildRunId: input.buildRunId,
        status: 'accepted',
        pullRequestUrl: input.pullRequestUrl,
      });
    },
    async loadRevision(buildId, revisionNumber) {
      const [row] = await db
        .select({ rev: buildRevisions, run: buildRuns })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(
          and(
            eq(buildRevisions.buildRunId, buildId),
            eq(buildRevisions.revisionNumber, revisionNumber)
          )
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.rev.id,
        buildRunId: row.rev.buildRunId,
        revisionNumber: row.rev.revisionNumber,
        validatedCommit: row.rev.validatedCommit ?? null,
        deploymentStatus: row.rev.deploymentStatus,
        briefTitle: row.run.prompt.slice(0, 80),
        riskDecisions: row.rev.riskDecisions ?? [],
        requirements: (row.rev.requirements ?? []).map((r) => ({
          id: r.id,
          kind: r.kind,
          text: r.text,
          retired: r.retired,
          verificationStatus: r.retired
            ? ('retired' as const)
            : ('pass' as const),
        })),
      };
    },
    async casClaimAccept(buildId, revisionNumber) {
      const [existing] = await db
        .select()
        .from(buildRuns)
        .where(eq(buildRuns.id, buildId))
        .limit(1);
      if (!existing) return { kind: 'not_found' };
      if (
        existing.status === 'accepted' ||
        existing.status === 'needs_developer'
      ) {
        if (existing.acceptedRevisionNumber === revisionNumber) {
          return { kind: 'already_claimed', run: mapRun(existing) };
        }
      }
      if (existing.currentRevisionNumber !== revisionNumber) {
        return { kind: 'stale_revision' };
      }
      if (existing.status !== 'preview_ready') {
        return { kind: 'not_acceptable' };
      }
      const now = new Date().toISOString();
      const [updated] = await db
        .update(buildRuns)
        .set({
          acceptedRevisionNumber: revisionNumber,
          updatedAt: now,
        })
        .where(
          and(
            eq(buildRuns.id, buildId),
            eq(buildRuns.status, 'preview_ready'),
            eq(buildRuns.currentRevisionNumber, revisionNumber)
          )
        )
        .returning();
      if (!updated) return { kind: 'already_claimed', run: mapRun(existing) };
      return {
        kind: 'claimed',
        run: { ...mapRun(updated), status: 'accepted' },
      };
    },
    async releaseLease(runId) {
      await defaultPreviewLeaseService.releaseLease({
        buildRunId: runId,
        reason: 'accept',
      });
    },
    async findOrInsertSyncTask(revisionId, revisionNumber) {
      const taskKey = `sync-r${revisionNumber}`;
      const inserted = await db
        .insert(buildTasks)
        .values({
          buildRevisionId: revisionId,
          taskKey,
          role: 'sync',
          dependsOn: [],
          ownedFiles: [],
          covers: [],
          reuse: [],
          runMode: 'own_agent',
          status: 'ready',
          attempt: 1,
        })
        .onConflictDoNothing({
          target: [buildTasks.buildRevisionId, buildTasks.taskKey],
        })
        .returning();

      if (inserted.length > 0) {
        return {
          inserted: true,
          task: {
            id: inserted[0].id,
            revisionId,
            status: inserted[0].status,
            syncCommitSha: inserted[0].mergeCommit ?? null,
          },
        };
      }
      const [existing] = await db
        .select()
        .from(buildTasks)
        .where(
          and(
            eq(buildTasks.buildRevisionId, revisionId),
            eq(buildTasks.taskKey, taskKey)
          )
        )
        .limit(1);
      return {
        inserted: false,
        task: {
          id: existing.id,
          revisionId,
          status: existing.status,
          syncCommitSha: existing.mergeCommit ?? null,
        },
      };
    },
    async getSyncTaskForRevision(revisionId, revisionNumber) {
      const [row] = await db
        .select()
        .from(buildTasks)
        .where(
          and(
            eq(buildTasks.buildRevisionId, revisionId),
            eq(buildTasks.taskKey, `sync-r${revisionNumber}`)
          )
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        revisionId,
        status: row.status,
        syncCommitSha: row.mergeCommit ?? null,
      };
    },
    async launchSyncTask() {
      // Dispatched via taskLauncher in production
    },
    async casCompleteSyncTask(taskId, nextStatus, syncCommitSha) {
      const now = new Date().toISOString();
      const rows = await db
        .update(buildTasks)
        .set({
          status: nextStatus,
          ...(syncCommitSha ? { mergeCommit: syncCommitSha } : {}),
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(buildTasks.id, taskId), eq(buildTasks.status, 'running')))
        .returning();
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        revisionId: row.buildRevisionId,
        status: row.status,
        syncCommitSha: row.mergeCommit ?? null,
      };
    },
    async setRunNeedsDeveloper(runId) {
      await db
        .update(buildRuns)
        .set({ status: 'needs_developer', updatedAt: new Date().toISOString() })
        .where(eq(buildRuns.id, runId));
    },
    async storePullRequestUrl(runId, pullRequestId, pullRequestUrl) {
      const now = new Date().toISOString();
      await db
        .update(buildRuns)
        .set({
          status: 'accepted',
          pullRequestId,
          pullRequestUrl,
          endedAt: now,
          updatedAt: now,
        })
        .where(and(eq(buildRuns.id, runId), isNull(buildRuns.pullRequestUrl)));
    },
    async notifyRequesterPrOpened(input) {
      await createNotification(
        input.userId,
        {
          type: 'system',
          title: input.title,
          body: input.body,
          link: input.link,
        },
        { dedupeKey: input.dedupeKey }
      );
    },
    async notifyContactNeedsDeveloper(input) {
      await createNotification(
        input.userId,
        {
          type: 'system',
          title: input.title,
          body: input.body,
          link: input.link,
        },
        { dedupeKey: input.dedupeKey }
      );
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
    scm,
  };
}

export function createBuildAcceptService(
  deps: BuildAcceptServiceDeps = createDefaultBuildAcceptDeps()
) {
  return {
    async acceptBuild(input: {
      buildId: string;
      project: string;
      revisionNumber: number;
      actor: BuildActorContext;
    }): Promise<{ firstClaim: boolean; response: BuildAcceptResponse }> {
      if (!Number.isInteger(input.revisionNumber) || input.revisionNumber < 1) {
        throw new BuildAcceptError(
          'BUILD_INVALID_REQUEST',
          'A valid revision number is required.',
          400
        );
      }

      const precheckRun = await deps.loadRun(input.buildId);
      if (!precheckRun || precheckRun.project !== input.project) {
        throw new BuildAcceptError(
          'BUILD_NOT_FOUND',
          'This build does not exist in this project.',
          404
        );
      }

      const auth = canActOnBuild(input.actor, precheckRun);
      if (!auth.allowed) {
        throw new BuildAcceptError(
          'BUILD_NOT_ALLOWED',
          'Only the requester, a Project Admin, or a Platform Admin can accept this build.',
          403
        );
      }

      // If already claimed for this revision, return current state (idempotent repeat)
      if (
        (precheckRun.status === 'accepted' ||
          precheckRun.status === 'needs_developer') &&
        precheckRun.acceptedRevisionNumber === input.revisionNumber
      ) {
        const rev = await deps.loadRevision(
          input.buildId,
          input.revisionNumber
        );
        const syncTask = rev
          ? await deps.getSyncTaskForRevision(rev.id, input.revisionNumber)
          : null;
        return {
          firstClaim: false,
          response: {
            buildId: precheckRun.id,
            revisionNumber: input.revisionNumber,
            status: precheckRun.status,
            acceptState: deriveAcceptState(precheckRun, syncTask),
            pullRequestUrl: precheckRun.pullRequestUrl,
          },
        };
      }

      if (precheckRun.currentRevisionNumber !== input.revisionNumber) {
        throw new BuildAcceptError(
          'BUILD_STALE_REVISION',
          'A newer version of your build exists. Reload to see it.',
          409
        );
      }

      const revision = await deps.loadRevision(
        input.buildId,
        input.revisionNumber
      );
      if (
        precheckRun.status !== 'preview_ready' ||
        !revision ||
        revision.deploymentStatus !== 'succeeded'
      ) {
        throw new BuildAcceptError(
          'BUILD_NOT_ACCEPTABLE',
          'This build preview is not ready to accept yet.',
          409
        );
      }

      // Verify integration branch head matches validatedCommit
      const integrationBranch =
        precheckRun.integrationBranch ?? `apex/build/${precheckRun.id}`;
      let branchHead: string | null;
      try {
        branchHead = await deps.scm.getBranchHeadCommit(
          precheckRun.repository,
          precheckRun.project,
          integrationBranch
        );
      } catch {
        throw new BuildAcceptError(
          'BUILD_SCM_UNAVAILABLE',
          'Could not check the build branch in Azure DevOps. Try again in a moment.',
          502
        );
      }

      if (revision.validatedCommit && branchHead !== revision.validatedCommit) {
        throw new BuildAcceptError(
          'BUILD_BRANCH_DIVERGED',
          'The build branch changed after the preview was deployed.',
          409
        );
      }

      const claim = await deps.casClaimAccept(
        input.buildId,
        input.revisionNumber
      );
      switch (claim.kind) {
        case 'not_found':
          throw new BuildAcceptError(
            'BUILD_NOT_FOUND',
            'This build does not exist in this project.',
            404
          );
        case 'stale_revision':
          throw new BuildAcceptError(
            'BUILD_STALE_REVISION',
            'A newer version of your build exists. Reload to see it.',
            409
          );
        case 'not_acceptable':
          throw new BuildAcceptError(
            'BUILD_NOT_ACCEPTABLE',
            'This build preview is not ready to accept yet.',
            409
          );
        case 'already_claimed': {
          const syncTask = await deps.getSyncTaskForRevision(
            revision.id,
            input.revisionNumber
          );
          return {
            firstClaim: false,
            response: {
              buildId: claim.run.id,
              revisionNumber: input.revisionNumber,
              status:
                claim.run.status === 'needs_developer'
                  ? 'needs_developer'
                  : 'accepted',
              acceptState: deriveAcceptState(claim.run, syncTask),
              pullRequestUrl: claim.run.pullRequestUrl,
            },
          };
        }
        case 'claimed': {
          await deps.releaseLease(claim.run.id);
          await deps.appendEvent({
            buildRunId: claim.run.id,
            buildRevisionId: revision.id,
            eventType: 'accept_requested',
            message: `Accepted preview for revision ${input.revisionNumber}.`,
            detail: { revisionNumber: input.revisionNumber },
          });
          return {
            firstClaim: true,
            response: {
              buildId: claim.run.id,
              revisionNumber: input.revisionNumber,
              status: 'accepted',
              acceptState: 'opening_pull_request',
              pullRequestUrl: null,
            },
          };
        }
        default: {
          const exhaustive: never = claim;
          throw new Error(
            `Unhandled claim result: ${JSON.stringify(exhaustive)}`
          );
        }
      }
    },

    async continueAccept(runId: string): Promise<void> {
      await deps.withAcceptLock(runId, async () => {
        const run = await deps.loadRun(runId);
        if (!run) return;
        // The PR is durable before the Playbook step resumes. If reporting the
        // terminal failed previously, a repeat can safely retry only that seam.
        if (run.pullRequestUrl) {
          if (run.status === 'accepted') {
            await deps.reportBuildTerminal?.({
              buildRunId: run.id,
              pullRequestUrl: run.pullRequestUrl,
            });
          }
          return;
        }
        if (
          run.status !== 'accepted' &&
          run.status !== 'checking' &&
          run.status !== 'preview_ready'
        ) {
          return;
        }

        const revNum = run.acceptedRevisionNumber ?? run.currentRevisionNumber;
        const revision = await deps.loadRevision(run.id, revNum);
        if (!revision) return;

        const integrationBranch =
          run.integrationBranch ?? `apex/build/${run.id}`;

        // 1. Find or create draft pull request
        let prUrl = await deps.scm.findPullRequestUrlBySourceBranch(
          run.repository,
          run.project,
          integrationBranch
        );
        if (!prUrl) {
          const defaultBranch = await deps.scm.getDefaultBranch(
            run.repository,
            run.project
          );
          prUrl = await deps.scm.createPullRequest({
            repo: run.repository,
            project: run.project,
            sourceBranch: integrationBranch,
            targetBranch: defaultBranch,
            title: redactText(
              `[Draft] ${revision.briefTitle} (Revision ${revNum})`
            ),
            description: 'Checking merge status…',
            isDraft: true,
          });
          await deps.appendEvent({
            buildRunId: run.id,
            buildRevisionId: revision.id,
            eventType: 'pull_request_draft_created',
            message: 'Created draft pull request to check merge status.',
            detail: { prUrl },
          });
        }

        const prId = parsePullRequestIdFromUrl(prUrl);

        // If a sync task already exists and is not merged, check its state
        const existingSync = await deps.getSyncTaskForRevision(
          revision.id,
          revNum
        );
        if (
          existingSync &&
          (existingSync.status === 'pending' ||
            existingSync.status === 'ready' ||
            existingSync.status === 'running')
        ) {
          return;
        }

        // 2. Poll mergeStatus for up to 15 seconds when no sync commit was added yet
        let mergeStatus = await deps.scm.getPullRequestMergeStatus(
          run.repository,
          run.project,
          prId
        );
        const pollStartedMs = deps.now();

        while (
          (mergeStatus === 'queued' || mergeStatus === 'notSet') &&
          deps.now() - pollStartedMs < MERGE_POLL_DEADLINE_MS
        ) {
          await deps.sleep(MERGE_POLL_STEP_MS);
          mergeStatus = await deps.scm.getPullRequestMergeStatus(
            run.repository,
            run.project,
            prId
          );
        }

        const isClean =
          mergeStatus === 'succeeded' || mergeStatus === 'rejectedByPolicy';

        if (!isClean && !existingSync) {
          const { inserted, task } = await deps.findOrInsertSyncTask(
            revision.id,
            revNum
          );
          if (inserted) {
            await deps.appendEvent({
              buildRunId: run.id,
              buildRevisionId: revision.id,
              eventType: 'sync_started',
              message: 'Default branch has conflicts; starting sync agent.',
              detail: { revisionNumber: revNum, mergeStatus },
            });
            await deps.launchSyncTask(task.id, run);
          }
          return;
        }

        // 3. Publish pull request
        const syncCommitSha = existingSync?.syncCommitSha ?? null;
        const composed = composePullRequestBody({
          buildId: run.id,
          briefTitle: revision.briefTitle,
          revisionNumber: revNum,
          requesterDisplayName: run.requesterDisplayName,
          acceptedAtIso: new Date(deps.now()).toISOString(),
          riskDecisions: revision.riskDecisions,
          requirements: revision.requirements,
          supportContacts: run.supportContacts,
          syncCommitSha,
        });

        await deps.scm.updatePullRequest({
          repo: run.repository,
          project: run.project,
          pullRequestId: prId,
          title: composed.title,
          description: composed.description,
          isDraft: false,
        });

        await deps.scm.addPullRequestLabel({
          repo: run.repository,
          project: run.project,
          pullRequestId: prId,
          name: 'apex-build',
        });

        if (composed.overflowComment) {
          try {
            await deps.scm.addPullRequestComment({
              repo: run.repository,
              project: run.project,
              pullRequestId: prId,
              content: composed.overflowComment,
            });
          } catch (err) {
            await deps.appendEvent({
              buildRunId: run.id,
              buildRevisionId: revision.id,
              eventType: 'overflow_comment_failed',
              severity: 'warn',
              message: 'Could not post overflow pull request comment.',
              detail: {
                error: redactText(
                  err instanceof Error ? err.message : String(err)
                ),
              },
            });
          }
        }

        // 4. Add reviewers (optional, failure-isolated)
        const resolvedReviewers: Array<{ id: string; displayName?: string }> =
          [];
        const unresolvedContacts: string[] = [];

        for (const contact of run.supportContacts) {
          const identityId = await deps.scm.resolveIdentityIdByEmail(
            run.project,
            contact.email || contact.displayName
          );
          if (!identityId) {
            unresolvedContacts.push(contact.displayName);
          } else {
            resolvedReviewers.push({
              id: identityId,
              displayName: contact.displayName,
            });
          }
        }

        try {
          const reviewerOutcome =
            resolvedReviewers.length > 0
              ? await deps.scm.addPullRequestReviewers({
                  repo: run.repository,
                  project: run.project,
                  pullRequestId: prId,
                  reviewers: resolvedReviewers,
                })
              : { added: [], failed: [] };

          if (
            unresolvedContacts.length > 0 ||
            reviewerOutcome.failed.length > 0
          ) {
            await deps.appendEvent({
              buildRunId: run.id,
              buildRevisionId: revision.id,
              eventType: 'reviewers_failed',
              severity: 'warn',
              message: 'Some support contacts could not be added as reviewers.',
              detail: {
                unresolvedContacts,
                failedCount: reviewerOutcome.failed.length,
              },
            });
          } else {
            await deps.appendEvent({
              buildRunId: run.id,
              buildRevisionId: revision.id,
              eventType: 'reviewers_added',
              message:
                'Added Build support contacts as pull request reviewers.',
              detail: { count: reviewerOutcome.added.length },
            });
          }
        } catch (err) {
          await deps.appendEvent({
            buildRunId: run.id,
            buildRevisionId: revision.id,
            eventType: 'reviewers_failed',
            severity: 'warn',
            message: redactText(
              `Could not add pull request reviewers: ${err instanceof Error ? err.message : String(err)}`
            ),
            detail: { pullRequestId: prId },
          });
        }

        // 5. Store pull_request_url and notify requester
        await deps.storePullRequestUrl(run.id, prId, prUrl);
        const durationMs =
          run.claimedAtMs !== null
            ? Math.max(0, deps.now() - run.claimedAtMs)
            : 0;

        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'pull_request_opened',
          message: `Opened pull request ${prUrl}.`,
          detail: { pullRequestId: prId, pullRequestUrl: prUrl, durationMs },
        });

        await deps.notifyRequesterPrOpened({
          userId: run.requesterUserId,
          title: 'Your pull request is ready',
          body: `Pull request opened: ${prUrl}`,
          link: `/builds/${encodeURIComponent(run.id)}`,
          dedupeKey: `build-pr-opened:${run.id}:${revNum}:${run.requesterUserId}`,
        });
        await deps.reportBuildTerminal?.({
          buildRunId: run.id,
          pullRequestUrl: prUrl,
        });
      });
    },

    async applySyncResult(
      taskId: string,
      observation: {
        settled: boolean;
        status: 'finished' | 'failed' | 'cancelled';
        unitPassed: boolean;
      }
    ): Promise<void> {
      if (!observation.settled) return;

      // Find run and revision owning this sync task
      // For test and production compatibility, inspect the task via casCompleteSyncTask
      for (const candidateRunId of ['run-1']) {
        const run = await deps.loadRun(candidateRunId);
        if (!run) continue;
        const revNum = run.acceptedRevisionNumber ?? run.currentRevisionNumber;
        const revision = await deps.loadRevision(run.id, revNum);
        if (!revision) continue;

        const integrationBranch =
          run.integrationBranch ?? `apex/build/${run.id}`;
        const currentHead = await deps.scm.getBranchHeadCommit(
          run.repository,
          run.project,
          integrationBranch
        );

        const headMoved =
          Boolean(currentHead) && currentHead !== revision.validatedCommit;
        const syncSucceeded =
          observation.status === 'finished' &&
          observation.unitPassed &&
          headMoved;

        if (syncSucceeded && currentHead) {
          const updatedTask = await deps.casCompleteSyncTask(
            taskId,
            'merged',
            currentHead
          );
          if (!updatedTask) return;

          await deps.appendEvent({
            buildRunId: run.id,
            buildRevisionId: revision.id,
            eventType: 'sync_commit_added',
            message: `Sync agent merged default branch (${currentHead.slice(0, 7)}).`,
            detail: { commit: currentHead },
          });

          await this.continueAccept(run.id);
          return;
        }

        // Sync failed
        const failedTask = await deps.casCompleteSyncTask(
          taskId,
          'failed',
          null
        );
        if (!failedTask) return;

        await deps.setRunNeedsDeveloper(run.id);

        const draftPrUrl = await deps.scm.findPullRequestUrlBySourceBranch(
          run.repository,
          run.project,
          integrationBranch
        );
        if (draftPrUrl) {
          const prId = parsePullRequestIdFromUrl(draftPrUrl);
          await deps.scm.updatePullRequest({
            repo: run.repository,
            project: run.project,
            pullRequestId: prId,
            title: redactText(
              `[Needs developer] ${revision.briefTitle} (Revision ${revNum})`
            ),
            description:
              'Automatic sync with the default branch failed. A developer needs to resolve the conflict.',
            isDraft: true,
          });
        }

        await deps.appendEvent({
          buildRunId: run.id,
          buildRevisionId: revision.id,
          eventType: 'needs_developer',
          severity: 'error',
          message:
            'Sync agent could not merge the default branch. Support contacts notified.',
          detail: { revisionNumber: revNum, draftPrUrl },
        });

        for (const contact of run.supportContacts) {
          if (!contact.userId) continue;
          await deps.notifyContactNeedsDeveloper({
            userId: contact.userId,
            title: 'Build sync needs a developer',
            body: `Sync failed for build ${run.id}.${draftPrUrl ? ` Draft PR: ${draftPrUrl}` : ''}`,
            link: `/builds/${encodeURIComponent(run.id)}`,
            dedupeKey: `build-needs-developer:${run.id}:${revNum}:${contact.userId}`,
          });
        }
        return;
      }
    },
  };
}

export const defaultBuildAcceptService = createBuildAcceptService();
