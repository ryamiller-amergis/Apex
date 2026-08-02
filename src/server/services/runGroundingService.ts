import type {
  ActiveRepositoryBranchQuery,
  CreateRunGroundingInput,
  RepoRole,
  RunGrounding,
  RunRef,
} from '../../shared/types/runGrounding';
import {
  runGroundingRepository,
  RunGroundingRepositoryError,
  type RunGroundingRepository,
} from './runGroundingRepository';

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

export interface RunGroundingService {
  activateGroundings(
    input: ActivateRunGroundingsInput
  ): Promise<ActivateRunGroundingsResult>;
  copyGrounding(
    from: RunRef,
    to: RunRef,
    role: RepoRole
  ): Promise<RunGrounding | null>;
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

export function createRunGroundingService(
  repository: RunGroundingRepository = runGroundingRepository,
  options: { now?: () => string } = {}
): RunGroundingService {
  const now = options.now ?? (() => new Date().toISOString());

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

    copyGrounding(from, to, role) {
      return repository.copyGrounding(from, to, role);
    },

    getGroundings(ref) {
      return repository.findByRun(ref);
    },

    findActiveByRepoBranch(query) {
      return repository.findActiveByRepoBranch(query);
    },

    reground(ref, role, newSha) {
      return repository.reground(ref, role, newSha);
    },

    deactivate(ref) {
      return repository.deactivateByRun(ref);
    },
  };
}

export const runGroundingService = createRunGroundingService();
