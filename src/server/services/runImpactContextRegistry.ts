import type { GroundingRunImpactContext } from '../../shared/types/groundingOperations';
import type { RunRef } from '../../shared/types/runGrounding';

export interface RunImpactContextRegistry {
  register(ref: RunRef, context: GroundingRunImpactContext): void;
  resolve(ref: RunRef): GroundingRunImpactContext | null;
  unregister(ref: RunRef): void;
}

function key(ref: RunRef): string {
  return [ref.runType, ref.runId, ref.project].join('\0');
}

function safeContext(
  context: GroundingRunImpactContext
): GroundingRunImpactContext | null {
  const authorId = context.authorId.trim();
  const title = context.title.trim().slice(0, 200);
  const caller = context.caller.trim();
  if (!authorId || !title || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(caller)) {
    return null;
  }
  const link =
    context.link?.startsWith('/') && !context.link.startsWith('//')
      ? context.link
      : undefined;
  return {
    authorId,
    title,
    caller,
    ...(link ? { link } : {}),
  };
}

export function createRunImpactContextRegistry(): RunImpactContextRegistry {
  const contexts = new Map<string, GroundingRunImpactContext>();
  return {
    register(ref, context) {
      const safe = safeContext(context);
      if (safe) contexts.set(key(ref), safe);
    },
    resolve(ref) {
      const context = contexts.get(key(ref));
      return context ? { ...context } : null;
    },
    unregister(ref) {
      contexts.delete(key(ref));
    },
  };
}

export const runImpactContextRegistry = createRunImpactContextRegistry();
