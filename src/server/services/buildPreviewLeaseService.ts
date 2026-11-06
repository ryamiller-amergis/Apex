/**
 * Preview lease and queue manager (FEAT-013, TBI-024 / S3).
 *
 * One preview lease per (project, repository) pair, granted first come first served.
 * Released on accept, cancel, deployment failure, or 24 hours after deployment.
 */
import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { buildPreviewLeases, buildRevisions, buildRuns } from '../db/schema';
import { appendBuildEvent } from './buildEventsService';
import { deletePreviewBundlesForRun } from './buildPreviewArtifactService';

export const PREVIEW_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

export type LeaseReleaseReason = 'accept' | 'cancel' | 'failure' | 'expiry';

export interface PreviewLeaseRecord {
  project: string;
  repository: string;
  buildRunId: string;
  buildRevisionId: string;
  grantedAt: string;
  expiresAt: string;
}

export interface WaitingRevisionRecord {
  revisionId: string;
  buildRunId: string;
  project: string;
  repository: string;
  queuedAt: string | null;
}

export interface PreviewLeaseStore {
  now: () => Date;
  tryUpsertLease: (input: {
    project: string;
    repository: string;
    buildRunId: string;
    buildRevisionId: string;
    grantedAt: string;
    expiresAt: string;
  }) => Promise<PreviewLeaseRecord | null>;
  deleteLeaseByRun: (
    buildRunId: string,
  ) => Promise<{ project: string; repository: string; buildRevisionId: string } | null>;
  deleteExpiredLeases: (
    nowIso: string,
  ) => Promise<
    Array<{
      project: string;
      repository: string;
      buildRunId: string;
      buildRevisionId: string;
    }>
  >;
  updateLeaseExpiry: (buildRunId: string, expiresAt: string) => Promise<boolean>;
  getLeaseForPair: (
    project: string,
    repository: string,
  ) => Promise<PreviewLeaseRecord | null>;
  listWaitingRevisions: (
    project: string,
    repository: string,
  ) => Promise<WaitingRevisionRecord[]>;
  findRevisionPair: (
    revisionId: string,
  ) => Promise<{
    revisionId: string;
    buildRunId: string;
    project: string;
    repository: string;
    deploymentStatus: string;
    runStatus: string;
  } | null>;
  appendEvent: (input: {
    buildRunId: string;
    buildRevisionId?: string | null;
    eventType: string;
    message: string;
    detail?: Record<string, unknown>;
  }) => Promise<void>;
}

export function createDrizzlePreviewLeaseStore(
  clock: () => Date = () => new Date(),
): PreviewLeaseStore {
  return {
    now: clock,
    async tryUpsertLease(input) {
      const rows = await db
        .insert(buildPreviewLeases)
        .values({
          project: input.project,
          repository: input.repository,
          buildRunId: input.buildRunId,
          buildRevisionId: input.buildRevisionId,
          grantedAt: input.grantedAt,
          expiresAt: input.expiresAt,
        })
        .onConflictDoUpdate({
          target: [buildPreviewLeases.project, buildPreviewLeases.repository],
          set: {
            buildRunId: input.buildRunId,
            buildRevisionId: input.buildRevisionId,
            grantedAt: input.grantedAt,
            expiresAt: input.expiresAt,
          },
          setWhere: or(
            lte(buildPreviewLeases.expiresAt, input.grantedAt),
            eq(buildPreviewLeases.buildRunId, input.buildRunId),
          ),
        })
        .returning();
      const row = rows[0];
      if (!row) return null;
      return {
        project: row.project,
        repository: row.repository,
        buildRunId: row.buildRunId,
        buildRevisionId: row.buildRevisionId,
        grantedAt: row.grantedAt,
        expiresAt: row.expiresAt,
      };
    },
    async deleteLeaseByRun(buildRunId) {
      const rows = await db
        .delete(buildPreviewLeases)
        .where(eq(buildPreviewLeases.buildRunId, buildRunId))
        .returning({
          project: buildPreviewLeases.project,
          repository: buildPreviewLeases.repository,
          buildRevisionId: buildPreviewLeases.buildRevisionId,
        });
      return rows[0] ?? null;
    },
    async deleteExpiredLeases(nowIso) {
      const rows = await db
        .delete(buildPreviewLeases)
        .where(lte(buildPreviewLeases.expiresAt, nowIso))
        .returning({
          project: buildPreviewLeases.project,
          repository: buildPreviewLeases.repository,
          buildRunId: buildPreviewLeases.buildRunId,
          buildRevisionId: buildPreviewLeases.buildRevisionId,
        });
      return rows;
    },
    async updateLeaseExpiry(buildRunId, expiresAt) {
      const rows = await db
        .update(buildPreviewLeases)
        .set({ expiresAt })
        .where(eq(buildPreviewLeases.buildRunId, buildRunId))
        .returning({ id: buildPreviewLeases.id });
      return rows.length > 0;
    },
    async getLeaseForPair(project, repository) {
      const [row] = await db
        .select()
        .from(buildPreviewLeases)
        .where(
          and(
            eq(buildPreviewLeases.project, project),
            eq(buildPreviewLeases.repository, repository),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        project: row.project,
        repository: row.repository,
        buildRunId: row.buildRunId,
        buildRevisionId: row.buildRevisionId,
        grantedAt: row.grantedAt,
        expiresAt: row.expiresAt,
      };
    },
    async listWaitingRevisions(project, repository) {
      const rows = await db
        .select({
          revisionId: buildRevisions.id,
          buildRunId: buildRevisions.buildRunId,
          project: buildRuns.project,
          repository: buildRuns.repository,
          queuedAt: buildRevisions.deploymentQueuedAt,
        })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(
          and(
            eq(buildRuns.project, project),
            eq(buildRuns.repository, repository),
            eq(buildRuns.status, 'deploying'),
            eq(buildRevisions.deploymentStatus, 'queued'),
          ),
        )
        .orderBy(
          asc(sql`coalesce(${buildRevisions.deploymentQueuedAt}, ${buildRevisions.createdAt})`),
          asc(buildRevisions.id),
        );
      return rows;
    },
    async findRevisionPair(revisionId) {
      const [row] = await db
        .select({
          revisionId: buildRevisions.id,
          buildRunId: buildRevisions.buildRunId,
          project: buildRuns.project,
          repository: buildRuns.repository,
          deploymentStatus: buildRevisions.deploymentStatus,
          runStatus: buildRuns.status,
        })
        .from(buildRevisions)
        .innerJoin(buildRuns, eq(buildRuns.id, buildRevisions.buildRunId))
        .where(eq(buildRevisions.id, revisionId))
        .limit(1);
      return row ?? null;
    },
    async appendEvent(input) {
      await appendBuildEvent(input);
    },
  };
}

export function createPreviewLeaseService(
  store: PreviewLeaseStore = createDrizzlePreviewLeaseStore(),
) {
  return {
    async tryGrantLease(input: {
      project: string;
      repository: string;
      buildRunId: string;
      buildRevisionId: string;
    }): Promise<{ granted: boolean; lease: PreviewLeaseRecord | null }> {
      const grantedAtDate = store.now();
      const grantedAt = grantedAtDate.toISOString();
      const expiresAt = new Date(
        grantedAtDate.getTime() + PREVIEW_LEASE_TTL_MS,
      ).toISOString();

      const lease = await store.tryUpsertLease({
        ...input,
        grantedAt,
        expiresAt,
      });

      if (!lease) {
        return { granted: false, lease: null };
      }

      await store.appendEvent({
        buildRunId: input.buildRunId,
        buildRevisionId: input.buildRevisionId,
        eventType: 'lease_granted',
        message: 'Preview environment lease granted.',
        detail: {
          project: input.project,
          repository: input.repository,
          expiresAt,
        },
      });
      return { granted: true, lease };
    },

    async releaseLease(input: {
      buildRunId: string;
      reason: LeaseReleaseReason;
    }): Promise<{
      released: boolean;
      pair: { project: string; repository: string } | null;
    }> {
      const deleted = await store.deleteLeaseByRun(input.buildRunId);
      if (!deleted) {
        return { released: false, pair: null };
      }

      await store.appendEvent({
        buildRunId: input.buildRunId,
        buildRevisionId: deleted.buildRevisionId,
        eventType: 'lease_released',
        message: `Preview environment lease released (${input.reason}).`,
        detail: {
          reason: input.reason,
          project: deleted.project,
          repository: deleted.repository,
        },
      });

      return {
        released: true,
        pair: { project: deleted.project, repository: deleted.repository },
      };
    },

    async expireLeases(): Promise<Array<{ project: string; repository: string }>> {
      const nowIso = store.now().toISOString();
      const expired = await store.deleteExpiredLeases(nowIso);
      const freedPairs: Array<{ project: string; repository: string }> = [];

      for (const item of expired) {
        await store.appendEvent({
          buildRunId: item.buildRunId,
          buildRevisionId: item.buildRevisionId,
          eventType: 'lease_released',
          message: 'Preview environment lease released (expiry).',
          detail: {
            reason: 'expiry',
            project: item.project,
            repository: item.repository,
          },
        });
        freedPairs.push({ project: item.project, repository: item.repository });
        try {
          await deletePreviewBundlesForRun(item.buildRunId);
        } catch {
          // Best-effort cleanup; the lease is already released.
        }
      }

      return freedPairs;
    },

    async extendLease(buildRunId: string, finishedAtIso: string): Promise<boolean> {
      const finishMs = new Date(finishedAtIso).getTime();
      const expiresAt = new Date(finishMs + PREVIEW_LEASE_TTL_MS).toISOString();
      return store.updateLeaseExpiry(buildRunId, expiresAt);
    },

    async getQueuePosition(revisionId: string): Promise<number | null> {
      const rev = await store.findRevisionPair(revisionId);
      if (!rev || rev.deploymentStatus !== 'queued' || rev.runStatus !== 'deploying') {
        return null;
      }
      const waiting = await store.listWaitingRevisions(rev.project, rev.repository);
      const idx = waiting.findIndex((item) => item.revisionId === revisionId);
      return idx === -1 ? null : idx + 1;
    },

    async claimNextWaitingLease(
      project: string,
      repository: string,
    ): Promise<PreviewLeaseRecord | null> {
      const waiting = await store.listWaitingRevisions(project, repository);
      const next = waiting[0];
      if (!next) return null;
      const result = await this.tryGrantLease({
        project,
        repository,
        buildRunId: next.buildRunId,
        buildRevisionId: next.revisionId,
      });
      return result.lease;
    },

    async getActiveLease(
      project: string,
      repository: string,
    ): Promise<PreviewLeaseRecord | null> {
      const lease = await store.getLeaseForPair(project, repository);
      if (!lease) return null;
      if (new Date(lease.expiresAt).getTime() <= store.now().getTime()) {
        return null;
      }
      return lease;
    },
  };
}

export const defaultPreviewLeaseService = createPreviewLeaseService();
