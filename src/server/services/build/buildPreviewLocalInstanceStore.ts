import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../db/drizzle';
import {
  buildPreviewArtifacts,
  buildPreviewInstances,
  buildRevisions,
} from '../../db/schema';
import type {
  LocalPreviewInstanceStore,
  LocalPreviewRevision,
} from './buildPreviewLocalWalkingSkeleton';

type Database = typeof db;
const ACTIVE_STATES = [
  'requested',
  'provisioning',
  'starting',
  'verifying',
  'ready',
  'suspended',
  'terminating',
] as const;

export function createDrizzleLocalPreviewInstanceStore(
  database: Database = db
): LocalPreviewInstanceStore {
  const requireUpdate = async (
    rows: Array<{ id: string }>,
    action: string
  ): Promise<void> => {
    if (rows.length !== 1) {
      throw new Error(`Local preview instance could not ${action}.`);
    }
  };

  return {
    async begin(input: LocalPreviewRevision) {
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`local-preview:${input.revisionId}`}))`
        );
        const [revision] = await tx
          .select({ deploymentStatus: buildRevisions.deploymentStatus })
          .from(buildRevisions)
          .where(eq(buildRevisions.id, input.revisionId))
          .limit(1);
        if (revision?.deploymentStatus !== 'deploying') {
          throw new Error(
            'A local preview instance can only start for a deploying revision.'
          );
        }
        const [existingArtifact] = await tx
          .select()
          .from(buildPreviewArtifacts)
          .where(eq(buildPreviewArtifacts.buildRevisionId, input.revisionId))
          .limit(1);

        let artifact = existingArtifact;
        if (!artifact) {
          [artifact] = await tx
            .insert(buildPreviewArtifacts)
            .values({
              buildRevisionId: input.revisionId,
              commit: input.commit,
              templateVersion: input.templateVersion,
              blobRef: input.runtimeBundle.blobRef,
              digest: input.runtimeBundle.digest,
              sizeBytes: input.runtimeBundle.sizeBytes,
            })
            .returning();
        }
        if (
          !artifact ||
          artifact.commit !== input.commit ||
          artifact.digest !== input.runtimeBundle.digest ||
          artifact.templateVersion !== input.templateVersion
        ) {
          throw new Error(
            'The persisted preview artifact does not match the requested revision.'
          );
        }

        const [activeInstance] = await tx
          .select({
            id: buildPreviewInstances.id,
            expiresAt: buildPreviewInstances.expiresAt,
          })
          .from(buildPreviewInstances)
          .where(
            and(
              eq(buildPreviewInstances.buildPreviewArtifactId, artifact.id),
              inArray(buildPreviewInstances.state, ACTIVE_STATES)
            )
          )
          .limit(1);
        if (activeInstance) {
          const now = new Date();
          if (new Date(activeInstance.expiresAt).getTime() > now.getTime()) {
            throw new Error(
              'The revision already has an active local preview instance.'
            );
          }
          await requireUpdate(
            await tx
              .update(buildPreviewInstances)
              .set({
                desiredState: 'failed',
                state: 'failed',
                readinessStatus: 'failed',
                readinessCheckedAt: now.toISOString(),
                failureCode: 'orchestration_abandoned',
                cleanupState: 'failed',
                lastOperationId: null,
                lastOperationKind: null,
                lastReconciledAt: now.toISOString(),
                updatedAt: now.toISOString(),
              })
              .where(
                and(
                  eq(buildPreviewInstances.id, activeInstance.id),
                  inArray(buildPreviewInstances.state, ACTIVE_STATES)
                )
              )
              .returning({ id: buildPreviewInstances.id }),
            'expire its abandoned instance'
          );
        }

        const [instance] = await tx
          .insert(buildPreviewInstances)
          .values({
            buildPreviewArtifactId: artifact.id,
            commit: input.commit,
            artifactDigest: input.runtimeBundle.digest,
            provider: 'local_docker',
            desiredState: 'provisioning',
            state: 'provisioning',
            expiresAt: input.expiresAt,
          })
          .returning({ id: buildPreviewInstances.id });
        if (!instance) {
          throw new Error('Local preview instance could not be created.');
        }
        return { artifactId: artifact.id, instanceId: instance.id };
      });
    },

    async listCleanupCandidates(revisionId) {
      const rows = await database
        .select({
          instanceId: buildPreviewInstances.id,
          dataHandle: buildPreviewInstances.dataHandle,
          sandboxHandle: buildPreviewInstances.providerHandle,
        })
        .from(buildPreviewInstances)
        .innerJoin(
          buildPreviewArtifacts,
          eq(
            buildPreviewArtifacts.id,
            buildPreviewInstances.buildPreviewArtifactId
          )
        )
        .where(
          and(
            eq(buildPreviewArtifacts.buildRevisionId, revisionId),
            eq(buildPreviewInstances.provider, 'local_docker'),
            eq(buildPreviewInstances.state, 'failed'),
            inArray(buildPreviewInstances.cleanupState, [
              'pending',
              'running',
              'failed',
            ])
          )
        );
      return rows.map((row) => ({
        instanceId: row.instanceId,
        dataHandle: row.dataHandle ?? `docker-db:${row.instanceId}`,
        sandboxHandle: row.sandboxHandle ?? `docker-sandbox:${row.instanceId}`,
      }));
    },

    async recordDataHandle(input) {
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            dataHandle: input.dataHandle,
            lastOperationId: input.operationId,
            lastOperationKind: 'data_create',
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(buildPreviewInstances.id, input.instanceId),
              eq(buildPreviewInstances.state, 'provisioning')
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        'record its database handle'
      );
    },

    async recordSandboxHandle(input) {
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            providerHandle: input.sandboxHandle,
            desiredState: 'starting',
            state: 'starting',
            lastOperationId: input.operationId,
            lastOperationKind: 'provision',
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(buildPreviewInstances.id, input.instanceId),
              eq(buildPreviewInstances.state, 'provisioning')
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        'record its sandbox handle'
      );
    },

    async markVerifying(instanceId) {
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            desiredState: 'verifying',
            state: 'verifying',
            lastOperationId: null,
            lastOperationKind: null,
            lastReconciledAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(buildPreviewInstances.id, instanceId),
              eq(buildPreviewInstances.state, 'starting')
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        'enter browser verification'
      );
    },

    async markReady(instanceId) {
      const now = new Date().toISOString();
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            desiredState: 'ready',
            state: 'ready',
            readinessStatus: 'passed',
            readinessCheckedAt: now,
            lastReconciledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(buildPreviewInstances.id, instanceId),
              eq(buildPreviewInstances.state, 'verifying'),
              eq(buildPreviewInstances.readinessStatus, 'pending')
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        'become ready'
      );
    },

    async markFailed(input) {
      const now = new Date().toISOString();
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            desiredState: 'failed',
            state: 'failed',
            readinessStatus: 'failed',
            readinessCheckedAt: now,
            failureCode: input.failureCode.slice(0, 200),
            lastOperationId: null,
            lastOperationKind: null,
            lastReconciledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(buildPreviewInstances.id, input.instanceId),
              inArray(buildPreviewInstances.state, ACTIVE_STATES)
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        'record failure'
      );
    },

    async markCleanup(input) {
      await requireUpdate(
        await database
          .update(buildPreviewInstances)
          .set({
            cleanupState: input.status,
            updatedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(buildPreviewInstances.id, input.instanceId),
              eq(buildPreviewInstances.state, 'failed')
            )
          )
          .returning({ id: buildPreviewInstances.id }),
        `mark cleanup ${input.status}`
      );
    },
  };
}
