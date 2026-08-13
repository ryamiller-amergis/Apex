/**
 * Map git `--progress` stderr lines onto a single 0–100 admin progress bar.
 *
 * Git percents are per-phase (objects 100% then deltas restart at 0%). Mapped
 * windows never jump backward: a lower mapped value keeps the previous overall.
 *
 * | Window | Phase |
 * | 0–10%  | Queued / Job starting |
 * | 10–60% | Mirror clone or fetch (Receiving objects / Resolving deltas) |
 * | 60–95% | Working-tree materialize (Checking out files) |
 * | 100%   | Ready |
 */

export type GitCheckoutProgressPhase =
  | 'queued'
  | 'starting'
  | 'receiving-objects'
  | 'resolving-deltas'
  | 'checking-out'
  | 'ready';

export interface ParsedGitProgressLine {
  phase: GitCheckoutProgressPhase;
  gitPercent: number;
}

const PHASE_WINDOWS: Record<GitCheckoutProgressPhase, { start: number; end: number }> = {
  queued: { start: 0, end: 10 },
  starting: { start: 5, end: 10 },
  'receiving-objects': { start: 10, end: 45 },
  'resolving-deltas': { start: 45, end: 60 },
  'checking-out': { start: 60, end: 95 },
  ready: { start: 100, end: 100 },
};

const PHASE_LABELS: Record<GitCheckoutProgressPhase, string> = {
  queued: 'Queued',
  starting: 'Job starting',
  'receiving-objects': 'Receiving objects',
  'resolving-deltas': 'Resolving deltas',
  'checking-out': 'Checking out files',
  ready: 'Ready',
};

export function parseGitProgressLine(line: string): ParsedGitProgressLine | null {
  const receiving = line.match(/Receiving objects:\s+(\d+)%/i);
  if (receiving) {
    return { phase: 'receiving-objects', gitPercent: Number(receiving[1]) };
  }
  const deltas = line.match(/Resolving deltas:\s+(\d+)%/i);
  if (deltas) {
    return { phase: 'resolving-deltas', gitPercent: Number(deltas[1]) };
  }
  const checkout = line.match(/Checking out files:\s+(\d+)%/i);
  if (checkout) {
    return { phase: 'checking-out', gitPercent: Number(checkout[1]) };
  }
  return null;
}

export function mapGitProgressToOverall(
  phase: GitCheckoutProgressPhase,
  gitPercent: number,
  previousOverall: number | null = null,
): number {
  const window = PHASE_WINDOWS[phase];
  const clampedGit = Math.min(100, Math.max(0, gitPercent));
  const mapped = Math.round(
    window.start + (clampedGit / 100) * (window.end - window.start),
  );
  const bounded = Math.min(100, Math.max(0, mapped));
  if (previousOverall != null && bounded < previousOverall) {
    return previousOverall;
  }
  return bounded;
}

export function formatGitProgressLabel(
  phase: GitCheckoutProgressPhase,
  gitPercent?: number,
): string {
  const base = PHASE_LABELS[phase];
  if (
    gitPercent == null
    || phase === 'queued'
    || phase === 'starting'
    || phase === 'ready'
  ) {
    return base;
  }
  return `${base} ${Math.min(100, Math.max(0, Math.round(gitPercent)))}%`;
}

export function parseGitProgressChunk(
  chunk: string,
  previousOverall: number | null = null,
): { percent: number; label: string } | null {
  const lines = chunk.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
  let overall = previousOverall;
  let last: { percent: number; label: string } | null = null;
  for (const line of lines) {
    const parsed = parseGitProgressLine(line);
    if (!parsed) continue;
    overall = mapGitProgressToOverall(parsed.phase, parsed.gitPercent, overall);
    last = {
      percent: overall,
      label: formatGitProgressLabel(parsed.phase, parsed.gitPercent),
    };
  }
  return last;
}
