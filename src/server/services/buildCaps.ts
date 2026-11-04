/**
 * Pure cap evaluation and resume stage derivation (FEAT-016, TBI-029 / S3).
 */
import type { BuildTaskStatus } from '../../shared/types/build';
import type {
  BuildCapSnapshot,
  CapCrossing,
} from '../../shared/types/buildRunControls';

/**
 * Evaluates cost, elapsed-time, and parallelism caps in order:
 * 1. cost (`used >= limit`)
 * 2. elapsed (`used >= limit`)
 * 3. parallelism (`runningAgents > parallelismLimit`, since the dispatcher allows up to `limit`)
 */
export function evaluateCaps(snapshot: BuildCapSnapshot): CapCrossing | null {
  if (snapshot.costLimitUsd > 0 && snapshot.costUsd >= snapshot.costLimitUsd) {
    return {
      reason: 'cost_cap',
      capName: 'cost',
      used: snapshot.costUsd,
      limit: snapshot.costLimitUsd,
    };
  }
  if (
    snapshot.elapsedLimitMs > 0
    && snapshot.elapsedMs >= snapshot.elapsedLimitMs
  ) {
    return {
      reason: 'elapsed_cap',
      capName: 'elapsed',
      used: snapshot.elapsedMs,
      limit: snapshot.elapsedLimitMs,
    };
  }
  if (
    snapshot.parallelismLimit > 0
    && snapshot.runningAgents > snapshot.parallelismLimit
  ) {
    return {
      reason: 'parallelism_cap',
      capName: 'parallelism',
      used: snapshot.runningAgents,
      limit: snapshot.parallelismLimit,
    };
  }
  return null;
}

export function deriveResumeStage(input: {
  hasValidatedPlan: boolean;
  tasks: ReadonlyArray<{ status: BuildTaskStatus }>;
}): 'planning' | 'building' | 'checking' {
  if (!input.hasValidatedPlan) {
    return 'planning';
  }
  const activeTasks = input.tasks.filter((t) => t.status !== 'omitted');
  if (activeTasks.length === 0) {
    return 'building';
  }
  const allMerged = activeTasks.every((t) => t.status === 'merged');
  return allMerged ? 'checking' : 'building';
}
