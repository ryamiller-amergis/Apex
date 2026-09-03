import { computeMedianDays, spanInDays } from './medianDuration';
import type {
  RelatedItemCycleTime,
  RelatedItemCycleTimeIncompleteReason,
  RelatedItemsCycleTimeResponse,
} from '../../shared/types/relatedItemCycleTime';

export interface RevisionLike {
  rev?: number;
  fields?: {
    'System.State'?: string;
    'System.ChangedDate'?: string;
  };
}

export interface LastEnterCycleTime {
  lastInProgressAt: string | null;
  lastDoneAt: string | null;
  cycleTimeDays: number | null;
  incompleteReason: RelatedItemCycleTimeIncompleteReason | null;
}

function roundToOneDecimal(days: number): number {
  return Math.round(days * 10) / 10;
}

function isDoneOrClosed(state: string): boolean {
  return state === 'Done' || state === 'Closed';
}

function sortRevisions(revisions: RevisionLike[]): RevisionLike[] {
  return [...revisions].sort((a, b) => {
    const da = Date.parse(a.fields?.['System.ChangedDate'] ?? '') || 0;
    const db = Date.parse(b.fields?.['System.ChangedDate'] ?? '') || 0;
    if (da !== db) return da - db;
    return (a.rev ?? 0) - (b.rev ?? 0);
  });
}

/**
 * Last enter In Progress → last enter Done or Closed.
 * A revision "enters" a state when the state differs from the previous revision.
 */
export function computeLastEnterInProgressToDone(revisions: RevisionLike[]): LastEnterCycleTime {
  let prevState: string | undefined;
  let lastInProgressAt: string | null = null;
  let lastDoneAt: string | null = null;

  for (const revision of sortRevisions(revisions)) {
    const state = revision.fields?.['System.State'];
    const changedDate = revision.fields?.['System.ChangedDate'];
    if (!state) continue;

    if (changedDate) {
      const iso = new Date(changedDate).toISOString();
      if (state === 'In Progress' && prevState !== 'In Progress') {
        lastInProgressAt = iso;
      }
      if (isDoneOrClosed(state) && !isDoneOrClosed(prevState ?? '')) {
        lastDoneAt = iso;
      }
    }

    prevState = state;
  }

  if (!lastInProgressAt) {
    return {
      lastInProgressAt,
      lastDoneAt,
      cycleTimeDays: null,
      incompleteReason: 'missing_in_progress',
    };
  }

  if (!lastDoneAt) {
    return {
      lastInProgressAt,
      lastDoneAt,
      cycleTimeDays: null,
      incompleteReason: 'missing_done',
    };
  }

  const span = spanInDays({ createdAt: lastInProgressAt, doneAt: lastDoneAt });
  if (span === null || span <= 0) {
    return {
      lastInProgressAt,
      lastDoneAt,
      cycleTimeDays: null,
      incompleteReason: 'end_not_after_start',
    };
  }

  return {
    lastInProgressAt,
    lastDoneAt,
    cycleTimeDays: roundToOneDecimal(span),
    incompleteReason: null,
  };
}

export function summarizeRelatedItemCycleTimes(
  items: RelatedItemCycleTime[],
): RelatedItemsCycleTimeResponse {
  const completedDays = items
    .map((item) => item.cycleTimeDays)
    .filter((days): days is number => days != null);

  const samples = items
    .filter((item) => item.cycleTimeDays != null && item.lastInProgressAt && item.lastDoneAt)
    .map((item) => ({
      createdAt: item.lastInProgressAt!,
      doneAt: item.lastDoneAt!,
    }));

  const avgDays =
    completedDays.length === 0
      ? null
      : roundToOneDecimal(completedDays.reduce((sum, days) => sum + days, 0) / completedDays.length);

  return {
    items,
    medianDays: computeMedianDays(samples),
    avgDays,
    sampleSize: completedDays.length,
    incompleteCount: items.length - completedDays.length,
  };
}
