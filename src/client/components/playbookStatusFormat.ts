/**
 * Presentation helpers for the Playbook status view.
 *
 * Separate from the components because these are the parts with rules attached — PBI-002's
 * "text, not colour alone" and PBI-003's "absolute and relative" — and a rule that lives inside a
 * component can only be tested by rendering one.
 *
 * Nothing here decides whether a deadline has passed in a way the view acts on. The client renders
 * the status the projection returned; the relative phrasing below is a reading aid, not a verdict.
 * That distinction is PBI-003's second criterion: a browser with a skewed clock must not be able to
 * make a live run look dead.
 */
import type { PlaybookRunStatus, PlaybookStepRunStatus } from '../../shared/types/playbook';

export interface FormattedDeadline {
  /** `2026-09-18 14:30` — the precise value, and what a screen reader is given. */
  absolute: string;
  /** `in 2 hours`, `3 hours ago`. Never shown on its own. */
  relative: string;
}

/**
 * Human labels for every run status.
 *
 * `expired` reads as "Expired (deadline passed)" rather than just "Expired" because the word alone
 * invites the reading "the run expired somehow". The distinction the status exists to draw is that
 * nobody came, not that something broke.
 */
const RUN_STATUS_LABELS: Record<PlaybookRunStatus, string> = {
  running: 'Running',
  suspended: 'Waiting',
  completed: 'Completed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  expired: 'Expired (deadline passed)',
};

const STEP_STATUS_LABELS: Record<PlaybookStepRunStatus, string> = {
  pending: 'Not started',
  running: 'Running',
  suspended: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  // Named so the next action is obvious: this step can be run again, and a person decides when.
  failed_retryable: 'Failed — can be retried',
  cancelled: 'Cancelled',
  expired: 'Expired (deadline passed)',
};

export function runStatusLabel(status: PlaybookRunStatus): string {
  return RUN_STATUS_LABELS[status] ?? status;
}

export function stepStatusLabel(status: PlaybookStepRunStatus): string {
  return STEP_STATUS_LABELS[status] ?? status;
}

/** Why a run is parked, in words rather than the stored token. */
export function suspendReasonLabel(reason: string): string {
  if (reason === 'approval_gate') return 'Waiting for someone to approve this step';
  if (reason === 'agent_run') return 'Waiting for the agent to finish its turn';
  return reason;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-09-18 14:30`, in the viewer's local time. */
export function absoluteTime(iso: string): string {
  const date = new Date(iso);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * `in 2 hours` / `3 hours ago`, from the largest unit that is not zero.
 *
 * Future and past are both needed: a deadline is normally ahead, but a step the sweep has not yet
 * reached can sit a little behind one, and "in -1 hours" is the kind of thing that survives to a
 * demo.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const deltaMs = new Date(iso).getTime() - now.getTime();
  const future = deltaMs >= 0;
  const seconds = Math.floor(Math.abs(deltaMs) / 1000);

  const phrase = ((): string => {
    if (seconds < 60) return 'less than a minute';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'}`;
  })();

  return future ? `in ${phrase}` : `${phrase} ago`;
}

/**
 * Both forms of a deadline. PBI-003's accessibility requirement is that the deadline is
 * understandable without colour cues, which means the relative form never appears alone.
 */
export function formatDeadline(iso: string, now: Date = new Date()): FormattedDeadline {
  return { absolute: absoluteTime(iso), relative: relativeTime(iso, now) };
}
