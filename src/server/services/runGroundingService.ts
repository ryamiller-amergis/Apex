import type {
  ActiveRepositoryBranchQuery,
  CreateRunGroundingInput,
  GroundingSurface,
  GroundingStalenessState,
  ReGroundResponse,
  RepoRole,
  RunGrounding,
  RunGroundingStatus,
  RunRef,
} from '../../shared/types/runGrounding';
import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { designDocs, interviews, prds } from '../db/schema';
import {
  runGroundingRepository,
  RunGroundingRepositoryError,
  type RunGroundingRepository,
} from './runGroundingRepository';
import {
  hasCachedCommit as hasCachedCommitInRepoCache,
  readCachedOriginSha as readCachedOriginShaFromRepoCache,
} from './repoCacheService';
import { isFeatureEnabled as evaluateFeatureFlag } from './featureFlagService';
import { materializeRunGrounding } from './runGroundingMaterializer';
import { emitGroundingActiveSetChanged } from './groundingMaintenanceEvents';
import { groundingStalenessService } from './groundingStalenessService';
import {
  groundingTelemetry,
  type GroundingTelemetry,
} from './groundingTelemetry';
import {
  materializeLinkedContextForPipelineHandoff,
} from './linkedContextMaterializerService';

export type RepositoryGroundingPin = Pick<
  CreateRunGroundingInput,
  'provider' | 'repository' | 'branch' | 'groundedSha'
>;

export interface ActivateRunGroundingsInput {
  run: RunRef;
  target: RepositoryGroundingPin;
  skill?: RepositoryGroundingPin;
}

export type ActivateRunGroundingsResult =
  | {
      ok: true;
      durableGrounding: true;
      fallback: 'none';
      groundings: RunGrounding[];
    }
  | {
      ok: false;
      durableGrounding: false;
      fallback: 'remote';
      code: 'run_grounding_activation_failed';
    };

export type GroundingMaterializationState = 'materialized' | 'unavailable';

export interface CopyGroundingByValueResult {
  grounding: RunGrounding | null;
  materialization: GroundingMaterializationState | 'deferred';
}

export interface ResolvedRunGroundingSurface {
  surface: GroundingSurface;
  domainRunId: string;
  run: RunRef;
  ownerId: string;
  participantIds: string[];
}

export interface RunGroundingService {
  activateGroundings(
    input: ActivateRunGroundingsInput
  ): Promise<ActivateRunGroundingsResult>;
  copyGrounding(
    from: RunRef,
    to: RunRef,
    role: RepoRole
  ): Promise<RunGrounding | null>;
  copyGroundingByValue(
    from: RunRef,
    to: RunRef,
    role: RepoRole
  ): Promise<CopyGroundingByValueResult>;
  getGroundings(ref: RunRef): Promise<RunGrounding[]>;
  findActiveByRepoBranch(
    query: ActiveRepositoryBranchQuery
  ): Promise<RunGrounding[]>;
  reground(
    ref: RunRef,
    role: RepoRole,
    newSha: string
  ): Promise<RunGrounding | null>;
  deactivate(ref: RunRef): Promise<number>;
  markTerminalInactive(ref: RunRef): Promise<number>;
  persistThenMarkTerminalInactive<T>(
    ref: RunRef,
    persist: () => Promise<T>
  ): Promise<{
    persisted: T;
    deactivatedCount: number;
  }>;
  getStatus(
    ref: RunRef,
    role: RepoRole,
    canReGround: boolean
  ): Promise<RunGroundingStatus | null>;
  reGroundFromCache(
    ref: RunRef,
    role: RepoRole
  ): Promise<ReGroundResponse | null>;
}

export interface RunGroundingServiceOptions {
  now?: () => string;
  materialize?: (
    grounding: RunGrounding,
    destination: RunRef
  ) => Promise<GroundingMaterializationState>;
  readCachedOriginSha?: (grounding: RunGrounding) => Promise<string | null>;
  hasCachedCommit?: (grounding: RunGrounding) => Promise<boolean>;
  evaluateStaleness?: (
    grounding: RunGrounding
  ) => Promise<GroundingStalenessState>;
  telemetry?: Pick<GroundingTelemetry, 'drift'>;
}

function createGroundingInput(
  run: RunRef,
  repoRole: RepoRole,
  pin: RepositoryGroundingPin,
  groundedAt: string
): CreateRunGroundingInput {
  return {
    runType: run.runType,
    runId: run.runId,
    project: run.project,
    repoRole,
    provider: pin.provider,
    repository: pin.repository,
    branch: pin.branch,
    groundedSha: pin.groundedSha,
    groundedAt,
  };
}

function materializationKey(ref: RunRef, role: RepoRole): string {
  return [ref.runType, ref.runId, ref.project, role].join('\0');
}

function uniqueParticipants(
  ...values: Array<string | null | undefined | string[]>
): string[] {
  return [
    ...new Set(
      values.flatMap((value) =>
        Array.isArray(value) ? value : value ? [value] : []
      )
    ),
  ];
}

export async function resolveRunGroundingSurface(
  surface: GroundingSurface,
  domainRunId: string
): Promise<ResolvedRunGroundingSurface | null> {
  if (surface === 'interview') {
    const row = await db.query.interviews.findFirst({
      where: eq(interviews.id, domainRunId),
      columns: {
        chatThreadId: true,
        project: true,
        authorId: true,
        prdOwnerId: true,
        designDocOwnerId: true,
        designPrototypeOwnerId: true,
        testCaseOwnerId: true,
        prdApproverIds: true,
        designDocApproverIds: true,
        designPrototypeApproverIds: true,
        testCaseApproverIds: true,
      },
    });
    if (!row?.chatThreadId) return null;
    return {
      surface,
      domainRunId,
      run: {
        runType: 'chat',
        runId: row.chatThreadId,
        project: row.project,
      },
      ownerId: row.authorId,
      participantIds: uniqueParticipants(
        row.authorId,
        row.prdOwnerId,
        row.designDocOwnerId,
        row.designPrototypeOwnerId,
        row.testCaseOwnerId,
        row.prdApproverIds,
        row.designDocApproverIds,
        row.designPrototypeApproverIds,
        row.testCaseApproverIds
      ),
    };
  }

  if (surface === 'prd') {
    const row = await db.query.prds.findFirst({
      where: eq(prds.id, domainRunId),
      columns: {
        chatThreadId: true,
        project: true,
        authorId: true,
        reviewerId: true,
        interviewId: true,
      },
    });
    if (!row?.chatThreadId) return null;
    const interview = row.interviewId
      ? await db.query.interviews.findFirst({
          where: eq(interviews.id, row.interviewId),
          columns: {
            prdOwnerId: true,
            prdApproverIds: true,
          },
        })
      : null;
    const ownerId = interview?.prdOwnerId ?? row.authorId;
    return {
      surface,
      domainRunId,
      run: {
        runType: 'chat',
        runId: row.chatThreadId,
        project: row.project,
      },
      ownerId,
      participantIds: uniqueParticipants(
        row.authorId,
        row.reviewerId,
        ownerId,
        interview?.prdApproverIds
      ),
    };
  }

  const row = await db.query.designDocs.findFirst({
    where: eq(designDocs.id, domainRunId),
    columns: {
      chatThreadId: true,
      project: true,
      authorId: true,
      reviewerId: true,
      prdId: true,
    },
  });
  if (!row?.chatThreadId) return null;
  const prd = await db.query.prds.findFirst({
    where: eq(prds.id, row.prdId),
    columns: { interviewId: true },
  });
  const interview = prd?.interviewId
    ? await db.query.interviews.findFirst({
        where: eq(interviews.id, prd.interviewId),
        columns: {
          designDocOwnerId: true,
          designDocApproverIds: true,
        },
      })
    : null;
  const ownerId = interview?.designDocOwnerId ?? row.authorId;
  return {
    surface,
    domainRunId,
    run: {
      runType: 'chat',
      runId: row.chatThreadId,
      project: row.project,
    },
    ownerId,
    participantIds: uniqueParticipants(
      row.authorId,
      row.reviewerId,
      ownerId,
      interview?.designDocApproverIds
    ),
  };
}

export async function propagatePipelineGrounding(
  from: RunRef,
  to: RunRef,
  userId: string,
  options: {
    service?: RunGroundingService;
    isFeatureEnabled?: typeof evaluateFeatureFlag;
    propagateLinkedContext?: typeof materializeLinkedContextForPipelineHandoff;
    deferMaterialization?: boolean;
  } = {}
): Promise<CopyGroundingByValueResult | null> {
  try {
    await (
      options.propagateLinkedContext ??
      materializeLinkedContextForPipelineHandoff
    )(from, to, userId);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    console.warn(
      `[linked-context] pipeline propagation unavailable error=${errorName}`,
    );
  }

  const enabled = await (options.isFeatureEnabled ?? evaluateFeatureFlag)(
    'repo-grounding-workspace-profile',
    { userId, project: to.project }
  );

  // Retain the enabled branch after two stable sprints at full rollout.
  // @feature-flag:repo-grounding-workspace-profile start winner=enabled
  if (!enabled) {
    // @feature-flag:repo-grounding-workspace-profile disabled-start
    const disabledResult = null;
    // @feature-flag:repo-grounding-workspace-profile disabled-end
    return disabledResult;
  }

  // @feature-flag:repo-grounding-workspace-profile enabled-start
  const service = options.service ?? runGroundingService;
  if (options.deferMaterialization) {
    const grounding = await service.copyGrounding(from, to, 'target');
    return {
      grounding,
      materialization: grounding ? 'deferred' : 'unavailable',
    };
  }
  const result = await service.copyGroundingByValue(from, to, 'target');
  if (result.grounding && result.materialization === 'unavailable') {
    console.warn(
      `[run-grounding] downstream materialization unavailable ` +
        `runType=${to.runType} runId=${to.runId}`,
    );
  }
  // @feature-flag:repo-grounding-workspace-profile enabled-end
  // @feature-flag:repo-grounding-workspace-profile end
  return result;
}

export function createRunGroundingService(
  repository: RunGroundingRepository = runGroundingRepository,
  options: RunGroundingServiceOptions = {}
): RunGroundingService {
  const now = options.now ?? (() => new Date().toISOString());
  const materialize = options.materialize ?? materializeRunGrounding;
  const readCachedOriginSha =
    options.readCachedOriginSha ?? readCachedOriginShaFromRepoCache;
  const hasPinnedCommit =
    options.hasCachedCommit ?? hasCachedCommitInRepoCache;
  const evaluateStaleness =
    options.evaluateStaleness ??
    ((grounding: RunGrounding) =>
      groundingStalenessService.evaluate(grounding));
  const telemetry = options.telemetry ?? groundingTelemetry;
  const materializationStates = new Map<
    string,
    GroundingMaterializationState
  >();

  return {
    async activateGroundings(input) {
      const groundedAt = now();
      const groundingInputs = [
        createGroundingInput(input.run, 'target', input.target, groundedAt),
      ];

      if (input.skill) {
        groundingInputs.push(
          createGroundingInput(input.run, 'skill', input.skill, groundedAt)
        );
      }

      try {
        const groundings = await repository.activateGroundings(groundingInputs);
        for (const grounding of groundings) {
          emitGroundingActiveSetChanged(grounding);
        }

        return {
          ok: true,
          durableGrounding: true,
          fallback: 'none',
          groundings,
        };
      } catch (error) {
        if (error instanceof RunGroundingRepositoryError) {
          return {
            ok: false,
            durableGrounding: false,
            fallback: 'remote',
            code: 'run_grounding_activation_failed',
          };
        }
        throw error;
      }
    },

    async copyGrounding(from, to, role) {
      const grounding = await repository.copyGrounding(from, to, role);
      if (grounding) emitGroundingActiveSetChanged(grounding);
      return grounding;
    },

    async copyGroundingByValue(from, to, role) {
      const grounding = await repository.copyGrounding(from, to, role);
      if (!grounding) {
        return { grounding: null, materialization: 'unavailable' };
      }
      emitGroundingActiveSetChanged(grounding);

      try {
        const materialization = await materialize(grounding, to);
        materializationStates.set(
          materializationKey(to, role),
          materialization,
        );
        return {
          grounding,
          materialization,
        };
      } catch {
        materializationStates.set(
          materializationKey(to, role),
          'unavailable',
        );
        return { grounding, materialization: 'unavailable' };
      }
    },

    getGroundings(ref) {
      return repository.findByRun(ref);
    },

    findActiveByRepoBranch(query) {
      return repository.findActiveByRepoBranch(query);
    },

    async reground(ref, role, newSha) {
      const grounding = await repository.reground(ref, role, newSha);
      if (grounding) emitGroundingActiveSetChanged(grounding);
      return grounding;
    },

    deactivate(ref) {
      return repository.deactivateByRun(ref);
    },

    markTerminalInactive(ref) {
      return repository.deactivateByRun(ref);
    },

    async persistThenMarkTerminalInactive(ref, persist) {
      const persisted = await persist();
      let deactivatedCount = 0;
      try {
        deactivatedCount = await repository.deactivateByRun(ref);
      } catch {
        console.warn(
          '[run-grounding] terminal deactivation failed after durable persistence'
        );
      }
      return { persisted, deactivatedCount };
    },

    async getStatus(ref, role, canReGround) {
      const rows = await repository.findByRun(ref);
      const grounding =
        rows.find((row) => row.repoRole === role && row.isActive) ??
        rows.find((row) => row.repoRole === role);
      if (!grounding) return null;

      const cachedOriginSha = await readCachedOriginSha(grounding);
      const materialization = materializationStates.get(
        materializationKey(ref, role),
      );
      const pinnedCommitAvailable =
        materialization === 'materialized' || await hasPinnedCommit(grounding);
      const stalenessState = await evaluateStaleness(grounding);
      const driftState =
        materialization === 'unavailable' || !pinnedCommitAvailable
          ? 'unavailable'
          : cachedOriginSha === null || cachedOriginSha === grounding.groundedSha
            ? 'grounded'
            : 'source-changed';
      if (driftState === 'source-changed') {
        telemetry.drift({
          caller: 'run-grounding-status',
          project: grounding.project,
          runId: grounding.runId,
          runType: grounding.runType,
          provider: grounding.provider,
          repository: grounding.repository,
          branch: grounding.branch,
        });
      }
      return {
        runType: grounding.runType,
        runId: grounding.runId,
        role,
        groundedSha: grounding.groundedSha,
        groundedShaShort: grounding.groundedSha.slice(0, 12),
        groundedAt: grounding.groundedAt,
        driftState,
        stalenessState,
        canReGround,
      };
    },

    async reGroundFromCache(ref, role) {
      const rows = await repository.findByRun(ref);
      const current =
        rows.find((row) => row.repoRole === role && row.isActive) ??
        rows.find((row) => row.repoRole === role);
      if (!current) return null;

      const cachedOriginSha = await readCachedOriginSha(current);
      if (!cachedOriginSha) return null;
      const replacement = await repository.reground(ref, role, cachedOriginSha);
      if (!replacement) return null;
      try {
        materializationStates.set(
          materializationKey(ref, role),
          await materialize(replacement, ref),
        );
      } catch {
        materializationStates.set(
          materializationKey(ref, role),
          'unavailable',
        );
      }
      return {
        previousSha: current.groundedSha,
        newSha: replacement.groundedSha,
        groundedAt: replacement.groundedAt,
      };
    },
  };
}

export const runGroundingService = createRunGroundingService();
