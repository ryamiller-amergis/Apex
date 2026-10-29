/**
 * `full` runs every background loop. `off` is for the staging slot: it shares
 * production's database, so its sweeps, reapers, recovery, and schedulers would
 * claim production's work. Unset means `full`, so local dev and any environment
 * without the setting behave as before.
 */
export type BackgroundJobsMode = 'full' | 'off';

export function resolveBackgroundJobsMode(
  raw: string | undefined,
): BackgroundJobsMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'full';
  if (value === 'full' || value === 'off') return value;
  console.warn(`[background-jobs] unknown BACKGROUND_JOBS_MODE="${raw}"; using full`);
  return 'full';
}

/** Whether this instance starts the loops that act on shared database state. */
export function runsSharedBackgroundJobs(mode: BackgroundJobsMode): boolean {
  switch (mode) {
    case 'full':
      return true;
    case 'off':
      return false;
    default: {
      const unhandled: never = mode;
      throw new Error(`Unhandled background jobs mode: ${String(unhandled)}`);
    }
  }
}
