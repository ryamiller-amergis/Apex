/**
 * Cap accrual and enforcement service for Build runs (FEAT-016, TBI-029 / S4).
 */
import { eq, sql } from 'drizzle-orm';
import type { BuildRunStatus, BuildSuspendReason as DbSuspendReason } from '../../shared/types/build';
import type { CapCrossing } from '../../shared/types/buildRunControls';
import { db } from '../db/drizzle';
import { buildRevisions, buildRuns } from '../db/schema';
import { stopRunningAgents } from './buildAgentStopper';
import { evaluateCaps } from './buildCaps';
import { appendBuildEvent } from './buildEventsService';
import { notifyBuildEvent } from './buildNotifier';
import { suspendRun } from './buildOrchestrator/dispatchWiring';

export const MAX_ELAPSED_TICK_CLAMP_MS = 120_000;
const ACTIVE_CAP_STAGES: ReadonlySet<BuildRunStatus> = new Set([
  'planning',
  'building',
  'checking',
]);

export interface CapEnforcementRunState {
  runId: string;
  project: string;
  status: BuildRunStatus;
  costUsedUsd: number;
  costLimitUsd: number;
  elapsedMs: number;
  elapsedLimitMs: number;
  elapsedCheckpointAtMs: number | null;
  revisionsUsed: number;
  revisionsLimit: number;
  parallelismLimit: number;
  agentRuns: Array<{
    id: string;
    status: string;
    startedAtMs: number;
    updatedAtMs: number;
    rateUsdPerMinute: number;
  }>;
}

export interface BuildCapEnforcementDeps {
  withCapLock: <T>(runId: string, fn: () => Promise<T>) => Promise<T>;
  loadRunState: (runId: string) => Promise<CapEnforcementRunState | null>;
  saveAccrual: (
    runId: string,
    nextElapsedMs: number,
    nextCheckpointMs: number,
    nextCostUsd: number,
  ) => Promise<void>;
  suspendForCap: (runId: string, crossing: CapCrossing) => Promise<boolean>;
}

export function checkRevisionCap(run: {
  revisionsUsed: number;
  revisionsLimit: number;
}): { allowed: true } | { allowed: false; message: string } {
  if (run.revisionsUsed >= run.revisionsLimit) {
    return {
      allowed: false,
      message: `This build used its ${run.revisionsLimit} revisions. Accept it or start a new build.`,
    };
  }
  return { allowed: true };
}

function createDefaultCapEnforcementDeps(): BuildCapEnforcementDeps {
  return {
    async withCapLock(runId, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`build_caps:${runId}`}))`,
        );
        return fn();
      });
    },
    async loadRunState(runId) {
      const [row] = await db
        .select({ run: buildRuns, rev: buildRevisions })
        .from(buildRuns)
        .leftJoin(
          buildRevisions,
          eq(buildRevisions.buildRunId, buildRuns.id),
        )
        .where(eq(buildRuns.id, runId))
        .limit(1);
      if (!row) return null;
      return {
        runId: row.run.id,
        project: row.run.project,
        status: row.run.status,
        costUsedUsd: Number(row.run.costUsedUsd),
        costLimitUsd: Number(row.run.costCapUsd),
        elapsedMs: (row.rev?.elapsedSecondsUsed ?? 0) * 1000,
        elapsedLimitMs: row.run.elapsedCapSeconds * 1000,
        elapsedCheckpointAtMs: Date.parse(row.run.updatedAt),
        revisionsUsed: row.run.revisionsUsed,
        revisionsLimit: row.run.revisionCap,
        parallelismLimit: row.run.parallelismCap,
        agentRuns: [],
      };
    },
    async saveAccrual(runId, nextElapsedMs, _nextCheckpointMs, nextCostUsd) {
      const now = new Date().toISOString();
      await db
        .update(buildRuns)
        .set({
          costUsedUsd: nextCostUsd.toFixed(4),
          updatedAt: now,
        })
        .where(eq(buildRuns.id, runId));
      await db
        .update(buildRevisions)
        .set({
          elapsedSecondsUsed: Math.floor(nextElapsedMs / 1000),
          updatedAt: now,
        })
        .where(eq(buildRevisions.buildRunId, runId));
    },
    async suspendForCap(runId, crossing) {
      const dbReason: DbSuspendReason =
        crossing.reason === 'cost_cap'
          ? 'cost_cap'
          : crossing.reason === 'elapsed_cap'
            ? 'elapsed_cap'
            : 'repair_cap';
      const won = await suspendRun(runId, dbReason);
      if (!won) return false;

      await appendBuildEvent({
        buildRunId: runId,
        eventType: 'cap_crossed',
        severity: 'warn',
        message: `Cap crossed: ${crossing.capName} (${crossing.used} / ${crossing.limit}).`,
        detail: {
          capName: crossing.capName,
          reason: crossing.reason,
          used: crossing.used,
          limit: crossing.limit,
        },
      });
      await stopRunningAgents(runId);
      await notifyBuildEvent({
        kind: 'run_suspended',
        buildRunId: runId,
        reason: crossing.reason,
      });
      return true;
    },
  };
}

export function createBuildCapEnforcementService(
  deps: BuildCapEnforcementDeps = createDefaultCapEnforcementDeps(),
) {
  return {
    async enforceCaps(runId: string, now: Date = new Date()): Promise<CapCrossing | null> {
      return deps.withCapLock(runId, async () => {
        const state = await deps.loadRunState(runId);
        if (!state || !ACTIVE_CAP_STAGES.has(state.status)) {
          return null;
        }

        const nowMs = now.getTime();
        const deltaMs =
          state.elapsedCheckpointAtMs !== null
            ? Math.min(
                MAX_ELAPSED_TICK_CLAMP_MS,
                Math.max(0, nowMs - state.elapsedCheckpointAtMs),
              )
            : 0;
        const nextElapsedMs = state.elapsedMs + deltaMs;

        // Recompute estimated cost from agent runs
        let recomputedCostUsd = 0;
        let runningAgents = 0;
        for (const ar of state.agentRuns) {
          const endMs = ar.status === 'running' ? nowMs : ar.updatedAtMs;
          const minutes = Math.max(0, (endMs - ar.startedAtMs) / 60_000);
          recomputedCostUsd += minutes * ar.rateUsdPerMinute;
          if (ar.status === 'running') {
            runningAgents += 1;
          }
        }
        const nextCostUsd = Math.max(state.costUsedUsd, recomputedCostUsd);

        await deps.saveAccrual(runId, nextElapsedMs, nowMs, nextCostUsd);

        const crossing = evaluateCaps({
          costUsd: nextCostUsd,
          costLimitUsd: state.costLimitUsd,
          elapsedMs: nextElapsedMs,
          elapsedLimitMs: state.elapsedLimitMs,
          revisionsUsed: state.revisionsUsed,
          revisionsLimit: state.revisionsLimit,
          runningAgents,
          parallelismLimit: state.parallelismLimit,
        });

        if (crossing) {
          await deps.suspendForCap(runId, crossing);
        }
        return crossing;
      });
    },
  };
}

export const defaultBuildCapEnforcementService = createBuildCapEnforcementService();
