import type {
  GroundingStalenessState,
  PreWarmTarget,
  RunGrounding,
} from '../../shared/types/runGrounding';
import { git, safeArgs } from '../utils/asyncGit';
import {
  getRepoCacheDir,
  readCachedOriginSha,
  type RepoCacheOptions,
} from './repoCacheService';
import { createGroundingTelemetry } from './groundingTelemetry';
import { trackEvent } from './telemetry';
import { runGroundingRepository } from './runGroundingRepository';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SOFT_STALE_AGE_MS = 7 * DAY_MS;
export const SOFT_STALE_COMMIT_COUNT = 50;
export const HARD_CHECKPOINT_AGE_MS = 14 * DAY_MS;

export interface GroundingStalenessService {
  evaluate(grounding: RunGrounding): Promise<GroundingStalenessState>;
  evaluateActive(
    target?: PreWarmTarget,
  ): Promise<GroundingStalenessState[]>;
}

export interface GroundingStalenessDependencies {
  now?: () => number;
  countCommitsBehind?: (grounding: RunGrounding) => Promise<number>;
  listActiveGroundings?: () => Promise<RunGrounding[]>;
  telemetry?: typeof trackEvent;
}

async function countCommitsBehindMirror(
  grounding: RunGrounding,
): Promise<number> {
  const originTip = await readCachedOriginSha(grounding);
  if (!originTip) return 0;
  const options: RepoCacheOptions = {
    provider: grounding.provider === 'azure_devops' ? 'ado' : 'github',
    project: grounding.project,
    repo: grounding.repository,
    branch: grounding.branch,
  };
  const cacheDir = getRepoCacheDir(options);
  const output = await git(
    safeArgs(cacheDir, [
      'rev-list',
      '--count',
      `${grounding.groundedSha}..${originTip}`,
    ]),
    { cwd: cacheDir },
  );
  const count = Number.parseInt(output.trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

export function createGroundingStalenessService(
  dependencies: GroundingStalenessDependencies = {},
): GroundingStalenessService {
  const now = dependencies.now ?? Date.now;
  const countCommitsBehind =
    dependencies.countCommitsBehind ?? countCommitsBehindMirror;
  const telemetry = dependencies.telemetry ?? trackEvent;
  const groundingOperations = createGroundingTelemetry(telemetry);
  const listActiveGroundings =
    dependencies.listActiveGroundings ??
    (() => runGroundingRepository.listActiveGroundings());

  const evaluate = async (
    grounding: RunGrounding,
  ): Promise<GroundingStalenessState> => {
    const ageMs = Math.max(0, now() - Date.parse(grounding.groundedAt));
    let state: GroundingStalenessState;
    let commitCount = 0;
    if (ageMs >= HARD_CHECKPOINT_AGE_MS) {
      state = 'hard-checkpoint';
    } else {
      commitCount = await countCommitsBehind(grounding);
      state =
        ageMs >= SOFT_STALE_AGE_MS ||
        commitCount >= SOFT_STALE_COMMIT_COUNT
          ? 'soft-stale'
          : 'fresh';
    }

    if (state !== 'fresh') {
      groundingOperations.staleness(
        {
          caller: 'grounding-staleness',
          provider: grounding.provider,
          project: grounding.project,
          runId: grounding.runId,
          runType: grounding.runType,
          repository: grounding.repository,
          branch: grounding.branch,
          result: state,
        },
        { ageMs, commitCount }
      );
    }
    return state;
  };

  return {
    evaluate,
    async evaluateActive(target) {
      const groundings = await listActiveGroundings();
      const matching = target
        ? groundings.filter(
            (grounding) =>
              grounding.provider === target.provider &&
              grounding.project === target.project &&
              grounding.repository === target.repository &&
              grounding.branch === target.branch,
          )
        : groundings;
      return Promise.all(matching.map(evaluate));
    },
  };
}

export const groundingStalenessService =
  createGroundingStalenessService();
