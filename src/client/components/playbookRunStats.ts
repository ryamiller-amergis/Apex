/**
 * Summary numbers for the Playbooks manage page and per-playbook dashboard.
 *
 * Computed from the run list the client already has. That list is capped by the server, so every
 * figure here describes the runs returned, and the views say so when the cap hides rows.
 */
import type { PlaybookRunStatus, PlaybookRunSummary } from '../../shared/types/playbook';

export type PlaybookRunTone = 'success' | 'error' | 'active' | 'waiting' | 'muted';

export interface PlaybookRunStats {
  total: number;
  completed: number;
  failed: number;
  running: number;
  waiting: number;
  /** Completed share of runs that reached an outcome. Null until one has. */
  successRate: number | null;
  averageDurationMs: number | null;
  lastRunAt: string | null;
}

export interface PlaybookActivityDay {
  /** `YYYY-MM-DD` in the viewer's local time. */
  date: string;
  completed: number;
  failed: number;
  other: number;
  total: number;
}

const RUN_TONES: Record<PlaybookRunStatus, PlaybookRunTone> = {
  completed: 'success',
  failed: 'error',
  expired: 'error',
  running: 'active',
  suspended: 'waiting',
  cancelled: 'muted',
};

export function runTone(status: PlaybookRunStatus): PlaybookRunTone {
  return RUN_TONES[status] ?? 'muted';
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function computeRunStats(runs: readonly PlaybookRunSummary[]): PlaybookRunStats {
  let completed = 0;
  let failed = 0;
  let running = 0;
  let waiting = 0;
  let durationTotal = 0;
  let durationCount = 0;
  let lastRunAt: string | null = null;

  for (const run of runs) {
    if (run.status === 'completed') completed += 1;
    else if (run.status === 'failed' || run.status === 'expired') failed += 1;
    else if (run.status === 'running') running += 1;
    else if (run.status === 'suspended') waiting += 1;

    if (run.completedAt) {
      const duration = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      if (Number.isFinite(duration) && duration >= 0) {
        durationTotal += duration;
        durationCount += 1;
      }
    }
    if (!lastRunAt || run.startedAt > lastRunAt) lastRunAt = run.startedAt;
  }

  // Cancelled runs are left out: someone chose to stop them, which says nothing about the playbook.
  const decided = completed + failed;
  return {
    total: runs.length,
    completed,
    failed,
    running,
    waiting,
    successRate: decided > 0 ? completed / decided : null,
    averageDurationMs: durationCount > 0 ? durationTotal / durationCount : null,
    lastRunAt,
  };
}

/** One bucket per day, oldest first, ending today. */
export function dailyActivity(
  runs: readonly PlaybookRunSummary[],
  days: number,
  now: Date = new Date(),
): PlaybookActivityDay[] {
  const buckets: PlaybookActivityDay[] = [];
  const index = new Map<string, PlaybookActivityDay>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    const bucket = { date: localDateKey(day), completed: 0, failed: 0, other: 0, total: 0 };
    buckets.push(bucket);
    index.set(bucket.date, bucket);
  }
  for (const run of runs) {
    const bucket = index.get(localDateKey(new Date(run.startedAt)));
    if (!bucket) continue;
    const tone = runTone(run.status);
    if (tone === 'success') bucket.completed += 1;
    else if (tone === 'error') bucket.failed += 1;
    else bucket.other += 1;
    bucket.total += 1;
  }
  return buckets;
}

export function groupRunsByDefinition(
  runs: readonly PlaybookRunSummary[],
): Map<string, PlaybookRunSummary[]> {
  const groups = new Map<string, PlaybookRunSummary[]>();
  for (const run of runs) {
    const list = groups.get(run.definitionId);
    if (list) list.push(run);
    else groups.set(run.definitionId, [run]);
  }
  return groups;
}

/** `42s`, `3m 10s`, `2h 5m`, `3d 4h`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const daysCount = Math.floor(hours / 24);
  return `${daysCount}d ${hours % 24}h`;
}

export function formatSuccessRate(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}
