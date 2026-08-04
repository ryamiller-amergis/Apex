/**
 * Background sweep that refreshes foundation skill install state for every
 * registered consumer repo, so the Platform Admin teams grid is trustworthy
 * without an admin manually clicking "Check" on each row.
 *
 * Sweep targets come from `project_skill_settings` (see
 * `listRegisteredSkillRepos`), which means newly registered team repos are
 * picked up automatically on the next tick.
 *
 * Each repo is checked independently and failures are swallowed per-repo — one
 * unreachable repo must not abort the sweep. Mirrors the standupScheduler
 * singleton pattern.
 */

import { checkCompatibility } from './foundationSkillCompatibilityService';
import { listRegisteredSkillRepos } from './foundationSkillTeamsService';

export interface SweepResult {
  scanned: number;
  failed: number;
  errors: string[];
}

/**
 * Re-check every registered repo. Sequential by design: each check performs
 * remote file fetches, and the grid is not latency-sensitive.
 */
export async function sweepAllRepos(actorId?: string | null): Promise<SweepResult> {
  const repos = await listRegisteredSkillRepos();
  const errors: string[] = [];
  let scanned = 0;

  for (const target of repos) {
    try {
      await checkCompatibility(
        {
          provider: target.provider,
          project:  target.project,
          repo:     target.repo,
          branch:   target.branch,
          // The registry is keyed by Apex project, so targeting resolves correctly.
          apexProject: target.project,
        },
        { id: actorId ?? null },
      );
      scanned++;
    } catch (e: unknown) {
      errors.push(`${target.project}/${target.repo}: ${(e as Error).message}`);
    }
  }

  return { scanned, failed: errors.length, errors };
}

export class FoundationSkillScanSchedulerService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

  start(): void {
    if (this.intervalId) {
      console.log('[FoundationSkillScanScheduler] Service already running');
      return;
    }

    console.log('[FoundationSkillScanScheduler] Starting service — sweeping every 6 hours');

    this.run();
    this.intervalId = setInterval(() => this.run(), this.CHECK_INTERVAL);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[FoundationSkillScanScheduler] Service stopped');
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const result = await sweepAllRepos(null);
      if (result.scanned > 0 || result.failed > 0) {
        console.log(
          `[FoundationSkillScanScheduler] Swept ${result.scanned} repo(s), ${result.failed} failed`,
        );
      }
      for (const err of result.errors) {
        console.warn(`[FoundationSkillScanScheduler] ${err}`);
      }
    } catch (err) {
      console.error('[FoundationSkillScanScheduler] Error during sweep:', (err as Error).message);
    } finally {
      this.isRunning = false;
    }
  }
}

export const foundationSkillScanScheduler = new FoundationSkillScanSchedulerService();
