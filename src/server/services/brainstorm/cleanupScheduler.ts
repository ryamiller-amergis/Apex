/**
 * Deletes idle Brainstorm clones and finishes interrupted cleanup.
 * This is not gated by the brainstorm flag: a turned-off feature still has to remove clones.
 */
import { brainstormSourceRuntime } from '../../routes/brainstormSources';

const INTERVAL_MS = 5 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await brainstormSourceRuntime().runMaintenance();
  } catch (err) {
    console.error('[BrainstormCleanup] sweep failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

export function startBrainstormCleanupScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref?.();
  console.log('[BrainstormCleanup] Starting service — checking every 5 minutes');
}

export function stopBrainstormCleanupScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
