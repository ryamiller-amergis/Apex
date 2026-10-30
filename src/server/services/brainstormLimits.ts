import { eq } from 'drizzle-orm';
import type { FrozenBrainstormTurn } from '../../shared/types/durableInteractiveTurn';
import { db } from '../db/drizzle';
import { brainstormProjectLimits } from '../db/schema';

/**
 * Source limits App Service freezes into every Brainstorm turn. The worker
 * reads them from the specification and holds no value of its own.
 *
 * A missing project row uses 5 GiB, 3 concurrent clones, and 30 minutes.
 * `BRAINSTORM_INACTIVITY_MINUTES` overrides the inactivity period only.
 */
export const DEFAULT_MAX_WORKSPACE_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_CONCURRENT_CLONES = 3;
export const DEFAULT_INACTIVITY_MS = 30 * 60_000;

export function appDefaultBrainstormLimits(
  env: NodeJS.ProcessEnv = process.env,
): FrozenBrainstormTurn['sourceLimits'] {
  const parsed = Number(env.BRAINSTORM_INACTIVITY_MINUTES);
  const inactivityMs = Number.isFinite(parsed) && parsed > 0
    ? Math.round(parsed * 60_000)
    : DEFAULT_INACTIVITY_MS;
  return {
    workspaceMaxBytes: DEFAULT_MAX_WORKSPACE_BYTES,
    maxConcurrentClones: DEFAULT_MAX_CONCURRENT_CLONES,
    inactivityMs,
  };
}

export async function resolveBrainstormLimits(
  project: string,
): Promise<FrozenBrainstormTurn['sourceLimits']> {
  const defaults = appDefaultBrainstormLimits();
  const row = await db.query.brainstormProjectLimits.findFirst({
    where: eq(brainstormProjectLimits.project, project),
  });
  if (!row) return defaults;
  return {
    workspaceMaxBytes: row.workspaceByteCap,
    maxConcurrentClones: row.concurrentCloneCap,
    inactivityMs: defaults.inactivityMs,
  };
}
