import {
  EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
  EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
  evaluateEditablePreviewReadiness,
  type EditablePreviewChangeSet,
  type EditablePreviewSessionProvider,
  type EditablePreviewSessionSnapshot,
  type EditablePreviewTask,
} from './buildPreviewProviderContracts';
import type { BuildRevisionFastEditCheckSummary } from '../../../shared/types/buildRevision';

const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_READINESS_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const EDIT_CHECKS = [
  'typecheck',
  'unit_test',
] as const satisfies readonly EditablePreviewTask[];

/** One Studio session serves every revision of a build. */
export function editablePreviewSessionIdForBuild(buildRunId: string): string {
  return `build-${buildRunId}`;
}

export interface EditablePreviewRevisionTarget {
  buildRunId: string;
  project: string;
  repository: string;
  integrationBranch: string;
  baseRevisionId: string;
  draftRevisionId: string;
  revisionNumber: number;
  baseCommit: string;
  templateVersion: string;
}

export interface MaterializedEditablePreviewSource {
  source: {
    snapshotDigest: string;
    snapshotRef: string;
  };
  developmentManifestDigest: string;
  databaseGrantRef: string;
  release(): Promise<void>;
}

export interface MaterializedEditablePreviewChangeSet {
  changeSet: EditablePreviewChangeSet;
  release(): Promise<void>;
}

export interface BuildEditablePreviewSessionDependencies {
  isAvailable(): boolean;
  provider: EditablePreviewSessionProvider;
  loadTarget(input: {
    buildRunId: string;
    draftRevisionId: string;
  }): Promise<EditablePreviewRevisionTarget | null>;
  materializeSource(
    target: EditablePreviewRevisionTarget
  ): Promise<MaterializedEditablePreviewSource>;
  materializeChangeSet(input: {
    target: EditablePreviewRevisionTarget;
    validatedCommit: string;
  }): Promise<MaterializedEditablePreviewChangeSet>;
  publishPreview(input: {
    target: EditablePreviewRevisionTarget;
    upstreamRef: string;
    expiresAt: string;
  }): Promise<string>;
  persistSession(input: {
    target: EditablePreviewRevisionTarget;
    previewUrl: string;
    workspaceVersion: number;
  }): Promise<void>;
  persistAppliedRevision(input: {
    target: EditablePreviewRevisionTarget;
    validatedCommit: string;
    previewUrl: string;
    workspaceVersion: number;
    changeSet: EditablePreviewChangeSet;
  }): Promise<void>;
  appendEvent(input: {
    buildRunId: string;
    buildRevisionId: string;
    eventType: string;
    severity?: 'info' | 'warn' | 'error';
    message: string;
    detail?: Record<string, unknown>;
  }): Promise<void>;
  now?(): Date;
  sessionTtlMs?: number;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
}

export type BeginEditablePreviewRevisionResult =
  | { kind: 'ready'; previewUrl: string; workspaceVersion: number }
  | { kind: 'unavailable' }
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: string };

export type ApplyEditablePreviewRevisionResult =
  | {
      kind: 'applied';
      previewUrl: string;
      workspaceVersion: number;
    }
  | { kind: 'unavailable' }
  | { kind: 'no_session' }
  | { kind: 'failed'; reason: string };

export type ApplyEditablePreviewDraftResult =
  | {
      kind: 'applied';
      previewUrl: string;
      workspaceVersion: number;
    }
  | { kind: 'unavailable' }
  | { kind: 'no_session' }
  | { kind: 'stale_workspace'; currentWorkspaceVersion: number }
  | { kind: 'failed'; reason: string };

export type RunEditablePreviewDraftChecksResult =
  | {
      kind: 'completed';
      previewUrl: string;
      workspaceVersion: number;
      summary: BuildRevisionFastEditCheckSummary;
    }
  | { kind: 'unavailable' }
  | { kind: 'no_session' }
  | { kind: 'stale_workspace'; currentWorkspaceVersion: number };

interface ActiveEditableSession {
  target: EditablePreviewRevisionTarget;
  handle: string;
  previewUrl: string;
  workspaceVersion: number;
  appliedCommit: string | null;
  appliedChangeSetDigests: Set<string>;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireAcceptedHandle(
  operation: string,
  result: Awaited<ReturnType<EditablePreviewSessionProvider['start']>>
): string {
  if (!result.ok) {
    throw new Error(`${operation}: ${result.error.message}`);
  }
  if (!result.accepted.handle) {
    throw new Error(`${operation}: provider did not return a session handle.`);
  }
  return result.accepted.handle;
}

function requireAccepted(
  operation: string,
  result: Awaited<
    | ReturnType<EditablePreviewSessionProvider['applyChangeSet']>
    | ReturnType<EditablePreviewSessionProvider['runTask']>
  >
): void {
  if (!result.ok) {
    throw new Error(`${operation}: ${result.error.message}`);
  }
}

async function pause(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createBuildEditablePreviewSessionService(
  dependencies: BuildEditablePreviewSessionDependencies
) {
  const sessions = new Map<string, ActiveEditableSession>();
  const inFlightStarts = new Map<
    string,
    Promise<BeginEditablePreviewRevisionResult>
  >();
  const inFlightValidatedApplies = new Map<
    string,
    Promise<ApplyEditablePreviewRevisionResult>
  >();
  const now = dependencies.now ?? (() => new Date());
  const sessionTtlMs = dependencies.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const readinessTimeoutMs =
    dependencies.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const pollIntervalMs =
    dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const waitUntilReady = async (
    handle: string
  ): Promise<EditablePreviewSessionSnapshot> => {
    const deadline = Date.now() + readinessTimeoutMs;
    let latest = await dependencies.provider.inspect({ handle });
    while (Date.now() < deadline) {
      if (latest.phase === 'failed' || latest.error) {
        throw new Error(
          latest.error?.message ?? 'Editable preview provider failed.'
        );
      }
      if (latest.snapshot) {
        const readiness = evaluateEditablePreviewReadiness(latest.snapshot);
        if (readiness.ready) return latest.snapshot;
        if (
          latest.snapshot.lifecycle === 'failed' ||
          latest.snapshot.lifecycle === 'expired' ||
          latest.snapshot.lifecycle === 'terminated'
        ) {
          throw new Error(
            `Editable preview stopped in ${latest.snapshot.lifecycle}.`
          );
        }
      }
      await pause(pollIntervalMs);
      latest = await dependencies.provider.inspect({ handle });
    }
    throw new Error('Timed out waiting for the editable preview session.');
  };

  const beginRevision = async (input: {
    buildRunId: string;
    draftRevisionId: string;
    persistPreviewUrl?: boolean;
  }): Promise<BeginEditablePreviewRevisionResult> => {
    if (!dependencies.isAvailable()) return { kind: 'unavailable' };
    const existing = sessions.get(input.buildRunId);
    if (existing && existing.target.draftRevisionId === input.draftRevisionId) {
      if (input.persistPreviewUrl !== false) {
        await dependencies.persistSession({
          target: existing.target,
          previewUrl: existing.previewUrl,
          workspaceVersion: existing.workspaceVersion,
        });
      }
      return {
        kind: 'ready',
        previewUrl: existing.previewUrl,
        workspaceVersion: existing.workspaceVersion,
      };
    }

    const pending = inFlightStarts.get(input.buildRunId);
    if (pending) return pending;

    const operation =
      (async (): Promise<BeginEditablePreviewRevisionResult> => {
        const target = await dependencies.loadTarget(input);
        if (!target) return { kind: 'not_found' };

        const reusable = sessions.get(input.buildRunId);
        if (reusable) {
          try {
            const snapshot = await waitUntilReady(reusable.handle);
            reusable.target = target;
            reusable.workspaceVersion = snapshot.workspace.version;
            reusable.appliedCommit = null;
            reusable.appliedChangeSetDigests = new Set(
              snapshot.workspace.appliedChangeSets.map(
                (changeSet) => changeSet.digest
              )
            );
            if (input.persistPreviewUrl !== false) {
              await dependencies.persistSession({
                target,
                previewUrl: reusable.previewUrl,
                workspaceVersion: reusable.workspaceVersion,
              });
            }
            await dependencies.appendEvent({
              buildRunId: target.buildRunId,
              buildRevisionId: target.draftRevisionId,
              eventType: 'studio.reused',
              message: 'Kept the editable preview open for this revision.',
              detail: {
                workspaceVersion: reusable.workspaceVersion,
              },
            });
            return {
              kind: 'ready',
              previewUrl: reusable.previewUrl,
              workspaceVersion: reusable.workspaceVersion,
            };
          } catch {
            sessions.delete(input.buildRunId);
            await dependencies.provider
              .destroy({
                idempotencyKey: `studio:${reusable.target.draftRevisionId}:replace`,
                handle: reusable.handle,
              })
              .catch(() => undefined);
          }
        }

        let materialized: MaterializedEditablePreviewSource | null = null;
        try {
          materialized = await dependencies.materializeSource(target);
          const expiresAt = new Date(
            now().getTime() + sessionTtlMs
          ).toISOString();
          const result = await dependencies.provider.start({
            idempotencyKey: `studio:${target.draftRevisionId}:start`,
            spec: {
              contractVersion: EDITABLE_PREVIEW_SESSION_CONTRACT_VERSION,
              correlation: {
                sessionId: editablePreviewSessionIdForBuild(target.buildRunId),
                buildRunId: target.buildRunId,
                baseRevisionId: target.baseRevisionId,
                draftRevisionId: target.draftRevisionId,
                revisionNumber: target.revisionNumber,
                baseCommit: target.baseCommit,
                templateVersion: target.templateVersion,
              },
              source: materialized.source,
              developmentManifestDigest: materialized.developmentManifestDigest,
              databaseGrantRef: materialized.databaseGrantRef,
              expiresAt,
              policy: {
                egress: 'denied',
                maxRuntimeSeconds: Math.floor(sessionTtlMs / 1_000),
                writableWorkspace: true,
              },
              requiredTransports: EDITABLE_PREVIEW_REQUIRED_TRANSPORTS,
            },
          });
          const handle = requireAcceptedHandle(
            'Could not start editable preview',
            result
          );
          const snapshot = await waitUntilReady(handle);
          const upstreamRef = snapshot.transport?.upstreamRef;
          if (!upstreamRef) {
            throw new Error('Editable preview did not return an upstream.');
          }
          const previewUrl = await dependencies.publishPreview({
            target,
            upstreamRef,
            expiresAt,
          });
          const session: ActiveEditableSession = {
            target,
            handle,
            previewUrl,
            workspaceVersion: snapshot.workspace.version,
            appliedCommit: null,
            appliedChangeSetDigests: new Set(
              snapshot.workspace.appliedChangeSets.map(
                (changeSet) => changeSet.digest
              )
            ),
          };
          sessions.set(target.buildRunId, session);
          if (input.persistPreviewUrl !== false) {
            await dependencies.persistSession({
              target,
              previewUrl,
              workspaceVersion: session.workspaceVersion,
            });
          }
          await dependencies.appendEvent({
            buildRunId: target.buildRunId,
            buildRevisionId: target.draftRevisionId,
            eventType: 'studio.ready',
            message: 'The editable preview is ready for this revision.',
            detail: {
              workspaceVersion: session.workspaceVersion,
            },
          });
          return {
            kind: 'ready',
            previewUrl,
            workspaceVersion: session.workspaceVersion,
          };
        } catch (error) {
          const reason = failureReason(error);
          await dependencies.appendEvent({
            buildRunId: target.buildRunId,
            buildRevisionId: target.draftRevisionId,
            eventType: 'studio.start_failed',
            severity: 'warn',
            message: 'The editable preview could not be started.',
            detail: { reason: reason.slice(0, 500) },
          });
          return { kind: 'failed', reason };
        } finally {
          await materialized?.release().catch(() => undefined);
        }
      })();
    inFlightStarts.set(input.buildRunId, operation);
    try {
      return await operation;
    } finally {
      inFlightStarts.delete(input.buildRunId);
    }
  };

  const applyValidatedRevision = async (input: {
    buildRunId: string;
    draftRevisionId: string;
    validatedCommit: string;
  }): Promise<ApplyEditablePreviewRevisionResult> => {
    if (!dependencies.isAvailable()) return { kind: 'unavailable' };
    let session = sessions.get(input.buildRunId);
    if (!session || session.target.draftRevisionId !== input.draftRevisionId) {
      const started = await beginRevision({
        buildRunId: input.buildRunId,
        draftRevisionId: input.draftRevisionId,
      });
      if (started.kind === 'unavailable') return started;
      if (started.kind === 'failed') return started;
      if (started.kind === 'not_found') return { kind: 'no_session' };
      session = sessions.get(input.buildRunId);
      if (!session) return { kind: 'no_session' };
    }
    if (session.appliedCommit === input.validatedCommit) {
      return {
        kind: 'applied',
        previewUrl: session.previewUrl,
        workspaceVersion: session.workspaceVersion,
      };
    }

    let materialized: MaterializedEditablePreviewChangeSet | null = null;
    let previewApplied = false;
    try {
      materialized = await dependencies.materializeChangeSet({
        target: session.target,
        validatedCommit: input.validatedCommit,
      });
      requireAccepted(
        'Could not apply editable preview change set',
        await dependencies.provider.applyChangeSet({
          idempotencyKey: `studio:${session.target.draftRevisionId}:${materialized.changeSet.digest}`,
          handle: session.handle,
          expectedWorkspaceVersion: session.workspaceVersion,
          changeSet: materialized.changeSet,
        })
      );
      const changed = await waitUntilReady(session.handle);
      session.workspaceVersion = changed.workspace.version;
      session.appliedChangeSetDigests.add(materialized.changeSet.digest);
      previewApplied = true;

      for (const task of EDIT_CHECKS) {
        requireAccepted(
          `Editable preview ${task} failed`,
          await dependencies.provider.runTask({
            idempotencyKey: `studio:${session.target.draftRevisionId}:${session.workspaceVersion}:${task}`,
            handle: session.handle,
            expectedWorkspaceVersion: session.workspaceVersion,
            task,
          })
        );
      }

      session.appliedCommit = input.validatedCommit;
      await dependencies.persistAppliedRevision({
        target: session.target,
        validatedCommit: input.validatedCommit,
        previewUrl: session.previewUrl,
        workspaceVersion: session.workspaceVersion,
        changeSet: materialized.changeSet,
      });
      await dependencies.appendEvent({
        buildRunId: session.target.buildRunId,
        buildRevisionId: session.target.draftRevisionId,
        eventType: 'studio.change_applied',
        message: 'Updated the editable preview with the validated revision.',
        detail: {
          validatedCommit: input.validatedCommit,
          workspaceVersion: session.workspaceVersion,
          changeSetDigest: materialized.changeSet.digest,
        },
      });
      return {
        kind: 'applied',
        previewUrl: session.previewUrl,
        workspaceVersion: session.workspaceVersion,
      };
    } catch (error) {
      const reason = failureReason(error);
      await dependencies.appendEvent({
        buildRunId: session.target.buildRunId,
        buildRevisionId: session.target.draftRevisionId,
        eventType: previewApplied
          ? 'studio.checks_failed'
          : 'studio.change_failed',
        severity: 'warn',
        message: previewApplied
          ? 'The editable preview updated, but its checks failed.'
          : 'The editable preview could not apply the validated revision.',
        detail: { reason: reason.slice(0, 500) },
      });
      return { kind: 'failed', reason };
    } finally {
      await materialized?.release().catch(() => undefined);
    }
  };

  return {
    beginRevision,

    async applyDraftChangeSet(input: {
      buildRunId: string;
      draftRevisionId: string;
      expectedWorkspaceVersion: number;
      changeSet: EditablePreviewChangeSet;
    }): Promise<ApplyEditablePreviewDraftResult> {
      if (!dependencies.isAvailable()) return { kind: 'unavailable' };
      let session = sessions.get(input.buildRunId);
      if (
        !session ||
        session.target.draftRevisionId !== input.draftRevisionId
      ) {
        const started = await beginRevision({
          buildRunId: input.buildRunId,
          draftRevisionId: input.draftRevisionId,
        });
        if (started.kind === 'unavailable') return started;
        if (started.kind === 'failed') return started;
        if (started.kind === 'not_found') return { kind: 'no_session' };
        session = sessions.get(input.buildRunId);
        if (!session) return { kind: 'no_session' };
      }
      if (session.appliedChangeSetDigests.has(input.changeSet.digest)) {
        return {
          kind: 'applied',
          previewUrl: session.previewUrl,
          workspaceVersion: session.workspaceVersion,
        };
      }
      if (session.workspaceVersion !== input.expectedWorkspaceVersion) {
        return {
          kind: 'stale_workspace',
          currentWorkspaceVersion: session.workspaceVersion,
        };
      }

      try {
        requireAccepted(
          'Could not apply editable preview draft',
          await dependencies.provider.applyChangeSet({
            idempotencyKey: `studio:${session.target.draftRevisionId}:draft:${input.changeSet.digest}`,
            handle: session.handle,
            expectedWorkspaceVersion: input.expectedWorkspaceVersion,
            changeSet: input.changeSet,
          })
        );
        const changed = await waitUntilReady(session.handle);
        session.workspaceVersion = changed.workspace.version;
        session.appliedChangeSetDigests.add(input.changeSet.digest);
        await dependencies.appendEvent({
          buildRunId: session.target.buildRunId,
          buildRevisionId: session.target.draftRevisionId,
          eventType: 'studio.preview_updated',
          message: 'Updated the editable preview. Checks are running.',
          detail: {
            workspaceVersion: session.workspaceVersion,
            changeSetDigest: input.changeSet.digest,
          },
        });
        return {
          kind: 'applied',
          previewUrl: session.previewUrl,
          workspaceVersion: session.workspaceVersion,
        };
      } catch (error) {
        const reason = failureReason(error);
        await dependencies.appendEvent({
          buildRunId: session.target.buildRunId,
          buildRevisionId: session.target.draftRevisionId,
          eventType: 'studio.draft_apply_failed',
          severity: 'warn',
          message: 'The editable preview could not apply this draft.',
          detail: { reason: reason.slice(0, 500) },
        });
        return { kind: 'failed', reason };
      }
    },

    async runDraftChecks(input: {
      buildRunId: string;
      draftRevisionId: string;
      workspaceVersion: number;
    }): Promise<RunEditablePreviewDraftChecksResult> {
      if (!dependencies.isAvailable()) return { kind: 'unavailable' };
      const session = sessions.get(input.buildRunId);
      if (
        !session ||
        session.target.draftRevisionId !== input.draftRevisionId
      ) {
        return { kind: 'no_session' };
      }
      if (session.workspaceVersion !== input.workspaceVersion) {
        return {
          kind: 'stale_workspace',
          currentWorkspaceVersion: session.workspaceVersion,
        };
      }

      const tasks: BuildRevisionFastEditCheckSummary['tasks'] = [];
      for (const task of EDIT_CHECKS) {
        const result = await dependencies.provider.runTask({
          idempotencyKey: `studio:${session.target.draftRevisionId}:${input.workspaceVersion}:${task}`,
          handle: session.handle,
          expectedWorkspaceVersion: input.workspaceVersion,
          task,
        });
        if (result.ok) {
          tasks.push({ name: task, status: 'passed' });
        } else {
          tasks.push({
            name: task,
            status: 'failed',
            message: result.error.message.slice(0, 500),
          });
        }
      }
      const summary: BuildRevisionFastEditCheckSummary = {
        status: tasks.some((task) => task.status === 'failed')
          ? 'failed'
          : 'passed',
        tasks,
      };
      await dependencies.appendEvent({
        buildRunId: session.target.buildRunId,
        buildRevisionId: session.target.draftRevisionId,
        eventType:
          summary.status === 'passed'
            ? 'studio.checks_passed'
            : 'studio.checks_failed',
        severity: summary.status === 'failed' ? 'warn' : 'info',
        message:
          summary.status === 'passed'
            ? 'The editable preview checks passed.'
            : 'The editable preview is updated, but checks failed.',
        detail: {
          workspaceVersion: input.workspaceVersion,
          checkStatus: summary.status,
        },
      });
      return {
        kind: 'completed',
        previewUrl: session.previewUrl,
        workspaceVersion: session.workspaceVersion,
        summary,
      };
    },

    async applyValidatedRevision(input: {
      buildRunId: string;
      draftRevisionId: string;
      validatedCommit: string;
    }): Promise<ApplyEditablePreviewRevisionResult> {
      const key = [
        input.buildRunId,
        input.draftRevisionId,
        input.validatedCommit,
      ].join(':');
      const pending = inFlightValidatedApplies.get(key);
      if (pending) return pending;
      const operation = applyValidatedRevision(input);
      inFlightValidatedApplies.set(key, operation);
      try {
        return await operation;
      } finally {
        if (inFlightValidatedApplies.get(key) === operation) {
          inFlightValidatedApplies.delete(key);
        }
      }
    },
  };
}
