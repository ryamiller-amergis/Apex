/**
 * Starts Playbooks whose daily UTC minute has arrived.
 * Run now is still the button on the Playbook. This clock is the other trigger.
 */
import { sweepDuePlaybookSchedules } from './playbookScheduleService';

const CHECK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function sweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sweepDuePlaybookSchedules();
  } catch (err) {
    console.error(
      '[playbook-schedule] sweep failed',
      err instanceof Error ? err.message : err,
    );
  } finally {
    running = false;
  }
}

export function startPlaybookScheduleScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweep();
  }, CHECK_MS);
  timer.unref?.();
  void sweep();
}

export function stopPlaybookScheduleScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
