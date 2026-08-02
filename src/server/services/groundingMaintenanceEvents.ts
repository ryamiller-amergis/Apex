import type { PreWarmTarget } from '../../shared/types/runGrounding';

export type GroundingActiveSetChangeHandler = (
  target: PreWarmTarget,
) => void;

const activeSetChangeHandlers = new Set<GroundingActiveSetChangeHandler>();

export function emitGroundingActiveSetChanged(target: PreWarmTarget): void {
  for (const handler of activeSetChangeHandlers) {
    handler(target);
  }
}

export function onGroundingActiveSetChanged(
  handler: GroundingActiveSetChangeHandler,
): () => void {
  activeSetChangeHandlers.add(handler);
  return () => activeSetChangeHandlers.delete(handler);
}
