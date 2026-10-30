/**
 * Join and loop decisions that do not need the engine.
 * A join's output is the arms it waited for. A loop that passes its cap fails.
 */

export interface JoinArmResult {
  stepId: string;
  status: 'completed' | 'failed';
  output?: Record<string, unknown>;
}

export type JoinPolicy = 'all' | { atLeast: number };

export function evaluateJoin(
  policy: JoinPolicy,
  arms: readonly JoinArmResult[],
): { ok: true; output: { arms: Record<string, Record<string, unknown>> } } | { ok: false; error: string } {
  const succeeded = arms.filter((arm) => arm.status === 'completed');
  const failed = arms.filter((arm) => arm.status === 'failed');
  const required = policy === 'all' ? arms.length : policy.atLeast;
  if (policy === 'all' && failed.length > 0) {
    return { ok: false, error: `Join waited for every arm and ${failed.map((arm) => arm.stepId).join(', ')} failed.` };
  }
  if (succeeded.length < required) {
    return { ok: false, error: `Join needed ${required} completed arms and saw ${succeeded.length}.` };
  }
  const output: Record<string, Record<string, unknown>> = {};
  for (const arm of succeeded) output[arm.stepId] = arm.output ?? {};
  return { ok: true, output: { arms: output } };
}

export class PlaybookIterationCapError extends Error {
  constructor(stepType: 'foreach' | 'until', maxIterations: number) {
    super(`${stepType} hit maxIterations ${maxIterations}.`);
    this.name = 'PlaybookIterationCapError';
  }
}

export function assertForeachWithinCap(itemCount: number, maxIterations: number): void {
  if (itemCount > maxIterations) throw new PlaybookIterationCapError('foreach', maxIterations);
}

export function assertUntilWithinCap(iteration: number, maxIterations: number, done: boolean): void {
  // Reaching the cap stops the loop. Only a count past the cap is an error.
  if (!done && iteration > maxIterations) throw new PlaybookIterationCapError('until', maxIterations);
}
