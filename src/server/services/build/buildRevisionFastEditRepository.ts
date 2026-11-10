import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  BuildRevisionFastEditCheckSummary,
  BuildRevisionFastEditRoute,
  BuildRevisionFastEditStatus,
} from '../../../shared/types/buildRevision';
import { db } from '../../db/drizzle';
import {
  buildRevisionFastEditAttempts,
  buildRevisionFastEditChangeSets,
} from '../../db/schema';
import {
  ACTIVE_BUILD_REVISION_FAST_EDIT_STATUSES,
  assertFastEditArtifactPointer,
  isActiveBuildRevisionFastEditStatus,
  isLegalBuildRevisionFastEditTransition,
  type BuildRevisionFastEditAttempt,
  type BuildRevisionFastEditChangeSet,
  type BuildRevisionFastEditRecoveryPlan,
  type FastEditArtifactPointer,
  type FastEditChangeSetKind,
} from './buildRevisionFastEditContracts';

export interface InMemoryBuildRevisionFastEditStore {
  attempts: Map<string, BuildRevisionFastEditAttempt>;
  attemptIdsByIdempotencyKey: Map<string, string>;
  changeSetsByAttempt: Map<string, BuildRevisionFastEditChangeSet[]>;
  changeSetIdsByIdempotencyKey: Map<string, string>;
}

export function createInMemoryBuildRevisionFastEditStore(): InMemoryBuildRevisionFastEditStore {
  return {
    attempts: new Map(),
    attemptIdsByIdempotencyKey: new Map(),
    changeSetsByAttempt: new Map(),
    changeSetIdsByIdempotencyKey: new Map(),
  };
}

export interface BeginBuildRevisionFastEditAttemptInput {
  buildRunId: string;
  buildRevisionId: string;
  idempotencyKey: string;
  requestDigest: string;
  baseCommit: string;
  baseSnapshot: FastEditArtifactPointer;
  expectedWorkspaceVersion: number;
  requestedAt: string;
  expiresAt: string;
}

export type BeginBuildRevisionFastEditAttemptResult =
  | { status: 'created'; attempt: BuildRevisionFastEditAttempt }
  | { status: 'existing'; attempt: BuildRevisionFastEditAttempt }
  | { status: 'active_conflict'; activeAttemptId: string };

export interface TransitionBuildRevisionFastEditAttemptInput {
  attemptId: string;
  expectedRecordVersion: number;
  to: BuildRevisionFastEditStatus;
  route?: BuildRevisionFastEditRoute | null;
  checkSummary?: BuildRevisionFastEditCheckSummary | null;
  agentCorrelationRef?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  previewUpdatedAt?: string | null;
  checksCompletedAt?: string | null;
}

export type TransitionBuildRevisionFastEditAttemptResult =
  | { status: 'updated'; attempt: BuildRevisionFastEditAttempt }
  | { status: 'not_found' }
  | { status: 'stale_record'; currentRecordVersion: number }
  | {
      status: 'illegal_transition';
      from: BuildRevisionFastEditStatus;
      to: BuildRevisionFastEditStatus;
    };

export interface AppendBuildRevisionFastEditChangeSetInput {
  attemptId: string;
  idempotencyKey: string;
  kind: FastEditChangeSetKind;
  artifact: FastEditArtifactPointer;
  expectedWorkspaceVersion: number;
  appliedWorkspaceVersion: number;
}

export type AppendBuildRevisionFastEditChangeSetResult =
  | {
      status: 'appended' | 'existing';
      changeSet: BuildRevisionFastEditChangeSet;
      attempt: BuildRevisionFastEditAttempt;
    }
  | { status: 'not_found' }
  | { status: 'stale_workspace'; currentWorkspaceVersion: number };

function copyAttempt(
  attempt: BuildRevisionFastEditAttempt,
): BuildRevisionFastEditAttempt {
  return structuredClone(attempt);
}

function copyChangeSet(
  changeSet: BuildRevisionFastEditChangeSet,
): BuildRevisionFastEditChangeSet {
  return structuredClone(changeSet);
}

function currentWorkspaceVersion(
  attempt: BuildRevisionFastEditAttempt,
): number {
  return attempt.appliedWorkspaceVersion ?? attempt.expectedWorkspaceVersion;
}

function requireTimestamp(value: string, name: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp.`);
  }
}

export function createBuildRevisionFastEditRepository(
  store: InMemoryBuildRevisionFastEditStore,
) {
  return {
    async beginAttempt(
      input: BeginBuildRevisionFastEditAttemptInput,
    ): Promise<BeginBuildRevisionFastEditAttemptResult> {
      assertFastEditArtifactPointer(input.baseSnapshot);
      if (!/^[0-9a-f]{40}$/.test(input.baseCommit)) {
        throw new Error('Fast-edit base commit must be a full Git commit.');
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(input.requestDigest)) {
        throw new Error('Fast-edit request digest must be a sha256 digest.');
      }
      if (
        !Number.isInteger(input.expectedWorkspaceVersion)
        || input.expectedWorkspaceVersion < 0
      ) {
        throw new Error('Expected workspace version must be non-negative.');
      }
      requireTimestamp(input.requestedAt, 'requestedAt');
      requireTimestamp(input.expiresAt, 'expiresAt');

      const existingId = store.attemptIdsByIdempotencyKey.get(
        input.idempotencyKey,
      );
      if (existingId) {
        const existing = store.attempts.get(existingId);
        if (!existing) {
          throw new Error('Fast-edit idempotency index is inconsistent.');
        }
        if (
          existing.buildRevisionId !== input.buildRevisionId
          || existing.requestDigest !== input.requestDigest
        ) {
          throw new Error(
            'Fast-edit idempotency key was reused for another request.',
          );
        }
        return { status: 'existing', attempt: copyAttempt(existing) };
      }

      const active = [...store.attempts.values()].find(
        (attempt) =>
          attempt.buildRunId === input.buildRunId
          && isActiveBuildRevisionFastEditStatus(attempt.status),
      );
      if (active) {
        return { status: 'active_conflict', activeAttemptId: active.id };
      }

      const timestamp = input.requestedAt;
      const attempt: BuildRevisionFastEditAttempt = {
        id: randomUUID(),
        buildRunId: input.buildRunId,
        buildRevisionId: input.buildRevisionId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        status: 'classify',
        route: null,
        recordVersion: 1,
        baseCommit: input.baseCommit,
        baseSnapshot: structuredClone(input.baseSnapshot),
        expectedWorkspaceVersion: input.expectedWorkspaceVersion,
        appliedWorkspaceVersion: null,
        checkSummary: null,
        agentCorrelationRef: null,
        failureCode: null,
        failureMessage: null,
        requestedAt: timestamp,
        previewUpdatedAt: null,
        checksCompletedAt: null,
        expiresAt: input.expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.attempts.set(attempt.id, attempt);
      store.attemptIdsByIdempotencyKey.set(input.idempotencyKey, attempt.id);
      store.changeSetsByAttempt.set(attempt.id, []);
      return { status: 'created', attempt: copyAttempt(attempt) };
    },

    async transitionAttempt(
      input: TransitionBuildRevisionFastEditAttemptInput,
    ): Promise<TransitionBuildRevisionFastEditAttemptResult> {
      const attempt = store.attempts.get(input.attemptId);
      if (!attempt) return { status: 'not_found' };
      if (attempt.recordVersion !== input.expectedRecordVersion) {
        return {
          status: 'stale_record',
          currentRecordVersion: attempt.recordVersion,
        };
      }
      if (!isLegalBuildRevisionFastEditTransition(attempt.status, input.to)) {
        return {
          status: 'illegal_transition',
          from: attempt.status,
          to: input.to,
        };
      }

      const updated: BuildRevisionFastEditAttempt = {
        ...attempt,
        status: input.to,
        route: input.route === undefined ? attempt.route : input.route,
        checkSummary:
          input.checkSummary === undefined
            ? attempt.checkSummary
            : structuredClone(input.checkSummary),
        agentCorrelationRef:
          input.agentCorrelationRef === undefined
            ? attempt.agentCorrelationRef
            : input.agentCorrelationRef,
        failureCode:
          input.failureCode === undefined
            ? input.to === 'failed'
              ? attempt.failureCode
              : null
            : input.failureCode,
        failureMessage:
          input.failureMessage === undefined
            ? input.to === 'failed'
              ? attempt.failureMessage
              : null
            : input.failureMessage,
        previewUpdatedAt:
          input.previewUpdatedAt === undefined
            ? attempt.previewUpdatedAt
            : input.previewUpdatedAt,
        checksCompletedAt:
          input.checksCompletedAt === undefined
            ? attempt.checksCompletedAt
            : input.checksCompletedAt,
        recordVersion: attempt.recordVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      store.attempts.set(updated.id, updated);
      return { status: 'updated', attempt: copyAttempt(updated) };
    },

    async appendChangeSet(
      input: AppendBuildRevisionFastEditChangeSetInput,
    ): Promise<AppendBuildRevisionFastEditChangeSetResult> {
      assertFastEditArtifactPointer(input.artifact);
      const attempt = store.attempts.get(input.attemptId);
      if (!attempt) return { status: 'not_found' };

      const existingId = store.changeSetIdsByIdempotencyKey.get(
        input.idempotencyKey,
      );
      if (existingId) {
        const existing = (store.changeSetsByAttempt.get(input.attemptId) ?? [])
          .find((changeSet) => changeSet.id === existingId);
        if (!existing) {
          throw new Error('Fast-edit change-set idempotency key was reused.');
        }
        return {
          status: 'existing',
          changeSet: copyChangeSet(existing),
          attempt: copyAttempt(attempt),
        };
      }

      const workspaceVersion = currentWorkspaceVersion(attempt);
      if (workspaceVersion !== input.expectedWorkspaceVersion) {
        return {
          status: 'stale_workspace',
          currentWorkspaceVersion: workspaceVersion,
        };
      }
      if (input.appliedWorkspaceVersion !== input.expectedWorkspaceVersion + 1) {
        throw new Error(
          'Applied workspace version must immediately follow the expected version.',
        );
      }

      const existingChangeSets =
        store.changeSetsByAttempt.get(input.attemptId) ?? [];
      const changeSet: BuildRevisionFastEditChangeSet = {
        id: randomUUID(),
        attemptId: input.attemptId,
        sequence: existingChangeSets.length + 1,
        idempotencyKey: input.idempotencyKey,
        kind: input.kind,
        artifact: structuredClone(input.artifact),
        expectedWorkspaceVersion: input.expectedWorkspaceVersion,
        appliedWorkspaceVersion: input.appliedWorkspaceVersion,
        createdAt: new Date().toISOString(),
      };
      existingChangeSets.push(changeSet);
      store.changeSetsByAttempt.set(input.attemptId, existingChangeSets);
      store.changeSetIdsByIdempotencyKey.set(
        input.idempotencyKey,
        changeSet.id,
      );
      const updatedAttempt = {
        ...attempt,
        appliedWorkspaceVersion: input.appliedWorkspaceVersion,
        recordVersion: attempt.recordVersion + 1,
        updatedAt: changeSet.createdAt,
      };
      store.attempts.set(attempt.id, updatedAttempt);
      return {
        status: 'appended',
        changeSet: copyChangeSet(changeSet),
        attempt: copyAttempt(updatedAttempt),
      };
    },

    async loadRecoveryPlan(
      attemptId: string,
    ): Promise<BuildRevisionFastEditRecoveryPlan | null> {
      const attempt = store.attempts.get(attemptId);
      if (!attempt) return null;
      const orderedChangeSets = (
        store.changeSetsByAttempt.get(attemptId) ?? []
      )
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(copyChangeSet);
      return {
        attempt: copyAttempt(attempt),
        baseSnapshot: structuredClone(attempt.baseSnapshot),
        orderedChangeSets,
      };
    },
  };
}

export type BuildRevisionFastEditRepository = ReturnType<
  typeof createBuildRevisionFastEditRepository
>;

type AttemptRow = typeof buildRevisionFastEditAttempts.$inferSelect;
type ChangeSetRow = typeof buildRevisionFastEditChangeSets.$inferSelect;

function mapAttemptRow(row: AttemptRow): BuildRevisionFastEditAttempt {
  return {
    id: row.id,
    buildRunId: row.buildRunId,
    buildRevisionId: row.buildRevisionId,
    idempotencyKey: row.idempotencyKey,
    requestDigest: row.requestDigest,
    status: row.status,
    route: row.route,
    recordVersion: row.recordVersion,
    baseCommit: row.baseCommit,
    baseSnapshot: {
      digest: row.baseSnapshotDigest,
      ref: row.baseSnapshotRef,
    },
    expectedWorkspaceVersion: row.expectedWorkspaceVersion,
    appliedWorkspaceVersion: row.appliedWorkspaceVersion,
    checkSummary: row.checkSummary,
    agentCorrelationRef: row.agentCorrelationRef,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    requestedAt: row.requestedAt,
    previewUpdatedAt: row.previewUpdatedAt,
    checksCompletedAt: row.checksCompletedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapChangeSetRow(
  row: ChangeSetRow,
): BuildRevisionFastEditChangeSet {
  return {
    id: row.id,
    attemptId: row.attemptId,
    sequence: row.sequence,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    artifact: {
      digest: row.artifactDigest,
      ref: row.artifactRef,
    },
    expectedWorkspaceVersion: row.expectedWorkspaceVersion,
    appliedWorkspaceVersion: row.appliedWorkspaceVersion,
    createdAt: row.createdAt,
  };
}

/**
 * Durable repository used by orchestration. Provider handles never enter these
 * rows; recovery uses the base artifact plus ordered opaque change-set refs.
 */
export function createPostgresBuildRevisionFastEditRepository() {
  return {
    async beginAttempt(
      input: BeginBuildRevisionFastEditAttemptInput,
    ): Promise<BeginBuildRevisionFastEditAttemptResult> {
      assertFastEditArtifactPointer(input.baseSnapshot);
      requireTimestamp(input.requestedAt, 'requestedAt');
      requireTimestamp(input.expiresAt, 'expiresAt');
      const [inserted] = await db
        .insert(buildRevisionFastEditAttempts)
        .values({
          buildRunId: input.buildRunId,
          buildRevisionId: input.buildRevisionId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          status: 'classify',
          baseCommit: input.baseCommit,
          baseSnapshotRef: input.baseSnapshot.ref,
          baseSnapshotDigest: input.baseSnapshot.digest,
          expectedWorkspaceVersion: input.expectedWorkspaceVersion,
          requestedAt: input.requestedAt,
          expiresAt: input.expiresAt,
          createdAt: input.requestedAt,
          updatedAt: input.requestedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        return { status: 'created', attempt: mapAttemptRow(inserted) };
      }

      const [existing] = await db
        .select()
        .from(buildRevisionFastEditAttempts)
        .where(
          eq(
            buildRevisionFastEditAttempts.idempotencyKey,
            input.idempotencyKey,
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.buildRevisionId !== input.buildRevisionId
          || existing.requestDigest !== input.requestDigest
        ) {
          throw new Error(
            'Fast-edit idempotency key was reused for another request.',
          );
        }
        return { status: 'existing', attempt: mapAttemptRow(existing) };
      }

      const [active] = await db
        .select({ id: buildRevisionFastEditAttempts.id })
        .from(buildRevisionFastEditAttempts)
        .where(
          and(
            eq(buildRevisionFastEditAttempts.buildRunId, input.buildRunId),
            inArray(
              buildRevisionFastEditAttempts.status,
              ACTIVE_BUILD_REVISION_FAST_EDIT_STATUSES,
            ),
          ),
        )
        .limit(1);
      if (active) {
        return { status: 'active_conflict', activeAttemptId: active.id };
      }
      throw new Error('Fast-edit attempt could not be created.');
    },

    async transitionAttempt(
      input: TransitionBuildRevisionFastEditAttemptInput,
    ): Promise<TransitionBuildRevisionFastEditAttemptResult> {
      const [existing] = await db
        .select()
        .from(buildRevisionFastEditAttempts)
        .where(eq(buildRevisionFastEditAttempts.id, input.attemptId))
        .limit(1);
      if (!existing) return { status: 'not_found' };
      if (existing.recordVersion !== input.expectedRecordVersion) {
        return {
          status: 'stale_record',
          currentRecordVersion: existing.recordVersion,
        };
      }
      if (!isLegalBuildRevisionFastEditTransition(existing.status, input.to)) {
        return {
          status: 'illegal_transition',
          from: existing.status,
          to: input.to,
        };
      }

      const [updated] = await db
        .update(buildRevisionFastEditAttempts)
        .set({
          status: input.to,
          route: input.route === undefined ? existing.route : input.route,
          checkSummary:
            input.checkSummary === undefined
              ? existing.checkSummary
              : input.checkSummary,
          agentCorrelationRef:
            input.agentCorrelationRef === undefined
              ? existing.agentCorrelationRef
              : input.agentCorrelationRef,
          failureCode:
            input.failureCode === undefined
              ? input.to === 'failed'
                ? existing.failureCode
                : null
              : input.failureCode,
          failureMessage:
            input.failureMessage === undefined
              ? input.to === 'failed'
                ? existing.failureMessage
                : null
              : input.failureMessage,
          previewUpdatedAt:
            input.previewUpdatedAt === undefined
              ? existing.previewUpdatedAt
              : input.previewUpdatedAt,
          checksCompletedAt:
            input.checksCompletedAt === undefined
              ? existing.checksCompletedAt
              : input.checksCompletedAt,
          recordVersion: existing.recordVersion + 1,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(buildRevisionFastEditAttempts.id, input.attemptId),
            eq(
              buildRevisionFastEditAttempts.recordVersion,
              input.expectedRecordVersion,
            ),
            eq(buildRevisionFastEditAttempts.status, existing.status),
          ),
        )
        .returning();
      if (updated) {
        return { status: 'updated', attempt: mapAttemptRow(updated) };
      }
      const [current] = await db
        .select({ recordVersion: buildRevisionFastEditAttempts.recordVersion })
        .from(buildRevisionFastEditAttempts)
        .where(eq(buildRevisionFastEditAttempts.id, input.attemptId))
        .limit(1);
      return current
        ? {
            status: 'stale_record',
            currentRecordVersion: current.recordVersion,
          }
        : { status: 'not_found' };
    },

    async appendChangeSet(
      input: AppendBuildRevisionFastEditChangeSetInput,
    ): Promise<AppendBuildRevisionFastEditChangeSetResult> {
      assertFastEditArtifactPointer(input.artifact);
      return db.transaction(async (tx) => {
        const [attemptRow] = await tx
          .select()
          .from(buildRevisionFastEditAttempts)
          .where(eq(buildRevisionFastEditAttempts.id, input.attemptId))
          .limit(1)
          .for('update');
        if (!attemptRow) return { status: 'not_found' as const };

        const [existing] = await tx
          .select()
          .from(buildRevisionFastEditChangeSets)
          .where(
            eq(
              buildRevisionFastEditChangeSets.idempotencyKey,
              input.idempotencyKey,
            ),
          )
          .limit(1);
        if (existing) {
          if (existing.attemptId !== input.attemptId) {
            throw new Error(
              'Fast-edit change-set idempotency key was reused.',
            );
          }
          return {
            status: 'existing' as const,
            changeSet: mapChangeSetRow(existing),
            attempt: mapAttemptRow(attemptRow),
          };
        }

        const workspaceVersion =
          attemptRow.appliedWorkspaceVersion
          ?? attemptRow.expectedWorkspaceVersion;
        if (workspaceVersion !== input.expectedWorkspaceVersion) {
          return {
            status: 'stale_workspace' as const,
            currentWorkspaceVersion: workspaceVersion,
          };
        }
        if (
          input.appliedWorkspaceVersion
          !== input.expectedWorkspaceVersion + 1
        ) {
          throw new Error(
            'Applied workspace version must immediately follow the expected version.',
          );
        }

        const [last] = await tx
          .select({ sequence: buildRevisionFastEditChangeSets.sequence })
          .from(buildRevisionFastEditChangeSets)
          .where(
            eq(
              buildRevisionFastEditChangeSets.attemptId,
              input.attemptId,
            ),
          )
          .orderBy(desc(buildRevisionFastEditChangeSets.sequence))
          .limit(1)
          .for('update');
        const sequence = (last?.sequence ?? 0) + 1;
        const [changeSet] = await tx
          .insert(buildRevisionFastEditChangeSets)
          .values({
            attemptId: input.attemptId,
            sequence,
            idempotencyKey: input.idempotencyKey,
            kind: input.kind,
            artifactRef: input.artifact.ref,
            artifactDigest: input.artifact.digest,
            expectedWorkspaceVersion: input.expectedWorkspaceVersion,
            appliedWorkspaceVersion: input.appliedWorkspaceVersion,
          })
          .returning();
        const [updatedAttempt] = await tx
          .update(buildRevisionFastEditAttempts)
          .set({
            appliedWorkspaceVersion: input.appliedWorkspaceVersion,
            recordVersion: attemptRow.recordVersion + 1,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(buildRevisionFastEditAttempts.id, input.attemptId))
          .returning();
        return {
          status: 'appended' as const,
          changeSet: mapChangeSetRow(changeSet),
          attempt: mapAttemptRow(updatedAttempt),
        };
      });
    },

    async loadRecoveryPlan(
      attemptId: string,
    ): Promise<BuildRevisionFastEditRecoveryPlan | null> {
      const [attempt] = await db
        .select()
        .from(buildRevisionFastEditAttempts)
        .where(eq(buildRevisionFastEditAttempts.id, attemptId))
        .limit(1);
      if (!attempt) return null;
      const changeSets = await db
        .select()
        .from(buildRevisionFastEditChangeSets)
        .where(eq(buildRevisionFastEditChangeSets.attemptId, attemptId))
        .orderBy(asc(buildRevisionFastEditChangeSets.sequence));
      const mappedAttempt = mapAttemptRow(attempt);
      return {
        attempt: mappedAttempt,
        baseSnapshot: mappedAttempt.baseSnapshot,
        orderedChangeSets: changeSets.map(mapChangeSetRow),
      };
    },
  };
}

export const buildRevisionFastEditRepository =
  createPostgresBuildRevisionFastEditRepository();
