import type { CloudAgentActivityEvent } from '../../shared/types/devWorkbench';

/** How many activity rows the log keeps. Merged reply chunks count as one row. */
const MAX_EVENTS = 500;

/** A merged reply stays readable without holding the whole token stream. */
const MAX_MERGED_DETAIL = 12_000;

function joinStreamText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const boundary = /[\s\n]$/.test(left) || /^[\s\n]/.test(right);
  const punctuation = /^[.,!?;:)\]}]+$/.test(right);
  const joined = boundary || punctuation ? `${left}${right}` : `${left} ${right}`;
  if (joined.length <= MAX_MERGED_DETAIL) return joined;
  const body = joined.startsWith('…') ? joined.slice(1) : joined;
  return `…${body.slice(-(MAX_MERGED_DETAIL - 1))}`;
}

function canMerge(last: CloudAgentActivityEvent, next: CloudAgentActivityEvent): boolean {
  return (last.kind === 'assistant' || last.kind === 'thinking') && last.kind === next.kind;
}

/**
 * Cursor sends a reply as many small chunks. Keep those chunks as one row so the
 * log shows the sentence, and so the 500-row cap does not drop the rest of the run.
 */
export function appendCloudActivityEvent(
  current: readonly CloudAgentActivityEvent[],
  event: CloudAgentActivityEvent,
): CloudAgentActivityEvent[] {
  const last = current[current.length - 1];
  if (last && canMerge(last, event)) {
    const next = current.slice(0, -1);
    next.push({
      ...last,
      detail: joinStreamText(last.detail ?? '', event.detail ?? ''),
      ...(event.status ? { status: event.status } : {}),
    });
    return next;
  }
  if (current.length < MAX_EVENTS) return [...current, event];
  return [...current.slice(current.length - MAX_EVENTS + 1), event];
}

/**
 * One sentence for the open Cloud agent step. The Playbook stays Waiting until
 * the branch and pull request are recorded, which is later than the reply ending.
 */
export function cloudAgentActivityLabel(
  events: readonly CloudAgentActivityEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'status' && event.status === 'completed') {
      return 'Reply finished. Waiting for the branch and pull request.';
    }
    if (event.kind === 'status' && (event.status === 'failed' || event.status === 'cancelled')) {
      return event.title;
    }
    if (event.kind === 'tool') {
      if (event.status === 'failed') return `${event.title} failed`;
      if (event.status === 'completed') continue;
      return `Using ${event.title}`;
    }
    if (event.kind === 'thinking') return 'Thinking';
    if (event.kind === 'assistant') return 'Writing the reply';
    if (event.kind === 'task' || event.kind === 'status') return event.title;
  }
  return null;
}

/** Queued until the first event, Working while the step is still live, Finished once it leaves. */
export function cloudAgentPhaseIndex(eventCount: number, live: boolean): number {
  if (!live) return 2;
  return eventCount === 0 ? 0 : 1;
}
