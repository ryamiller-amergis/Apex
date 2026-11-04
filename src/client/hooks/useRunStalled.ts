import { useEffect, useState } from 'react';

export const RUN_STALLED_AFTER_MS = 30_000;
const CHECK_INTERVAL_MS = 5_000;

export const RUN_STALLED_NOTICE =
  'No updates for a bit. The agent is still working — if it was interrupted, it will restart on its own. No need to refresh.';

/**
 * True while a run is active and nothing has arrived for
 * RUN_STALLED_AFTER_MS. `lastProgressAt` may still hold the previous turn's
 * time, so the wait is counted from whichever is later: that or the moment
 * the run became active.
 */
export function useRunStalled(active: boolean, lastProgressAt: number | null): boolean {
  const [clock, setClock] = useState<{ activeSince: number; now: number } | null>(null);

  useEffect(() => {
    if (!active) return;
    const activeSince = Date.now();
    const tick = () => setClock({ activeSince, now: Date.now() });
    tick();
    const timer = window.setInterval(tick, CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      setClock(null);
    };
  }, [active]);

  if (!active || !clock) return false;
  const lastActivity = Math.max(lastProgressAt ?? 0, clock.activeSince);
  return clock.now - lastActivity >= RUN_STALLED_AFTER_MS;
}
