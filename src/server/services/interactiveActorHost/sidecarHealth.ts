import type { Request, Response } from 'express';

export type SidecarProblem =
  | 'sidecar-unreachable'
  | 'placement-disconnected'
  | 'actor-type-missing';

export type SidecarCheck =
  | { healthy: true }
  | { healthy: false; problem: SidecarProblem; detail: string };

export type InteractiveHealthReport =
  | { status: 'ok' }
  | { status: 'degraded'; problem: SidecarProblem; detail: string }
  | { status: 'unhealthy'; problem: SidecarProblem; detail: string };

interface ActorTypeCount {
  type?: unknown;
}

interface DaprMetadata {
  actors?: ActorTypeCount[];
  actorRuntime?: {
    activeActors?: ActorTypeCount[];
    placement?: unknown;
  };
}

/** A sidecar that outlived an app restart can stay up while it no longer routes turns here. */
export const SIDECAR_UNHEALTHY_GRACE_MS = 60_000;
const METADATA_TIMEOUT_MS = 2_000;

function listsActorType(entries: ActorTypeCount[] | undefined, actorType: string): boolean {
  return Array.isArray(entries) && entries.some((entry) => entry?.type === actorType);
}

export function evaluateSidecarMetadata(metadata: unknown, actorType: string): SidecarCheck {
  if (!metadata || typeof metadata !== 'object') {
    return { healthy: false, problem: 'sidecar-unreachable', detail: 'metadata response was empty' };
  }
  const { actors, actorRuntime } = metadata as DaprMetadata;
  const placement = actorRuntime?.placement;
  // Dapr reports "placement: connected" or "placement: disconnected".
  if (typeof placement === 'string' && !/(^|\s)connected$/i.test(placement.trim())) {
    return { healthy: false, problem: 'placement-disconnected', detail: placement };
  }
  if (!listsActorType(actorRuntime?.activeActors, actorType) && !listsActorType(actors, actorType)) {
    return {
      healthy: false,
      problem: 'actor-type-missing',
      detail: `sidecar does not host actor type ${actorType}`,
    };
  }
  return { healthy: true };
}

export interface SidecarHealthMonitorDeps {
  actorType: string;
  fetchMetadata: () => Promise<unknown>;
  requestSidecarShutdown: () => Promise<void>;
  now: () => number;
  graceMs?: number;
}

/**
 * Reports `unhealthy` only after the sidecar has looked wrong for the whole
 * grace period, then asks the sidecar to shut down once so Container Apps
 * restarts it with the app's current actor registration.
 */
export function createSidecarHealthMonitor(deps: SidecarHealthMonitorDeps) {
  const graceMs = deps.graceMs ?? SIDECAR_UNHEALTHY_GRACE_MS;
  let failingSince: number | null = null;
  let shutdownRequested = false;

  async function inspect(): Promise<SidecarCheck> {
    try {
      return evaluateSidecarMetadata(await deps.fetchMetadata(), deps.actorType);
    } catch (error) {
      return {
        healthy: false,
        problem: 'sidecar-unreachable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    async check(): Promise<InteractiveHealthReport> {
      const result = await inspect();
      if (result.healthy) {
        if (failingSince !== null) {
          console.log(JSON.stringify({ event: 'InteractiveSidecarRecovered' }));
        }
        failingSince = null;
        shutdownRequested = false;
        return { status: 'ok' };
      }
      const now = deps.now();
      if (failingSince === null) {
        failingSince = now;
        console.warn(JSON.stringify({
          event: 'InteractiveSidecarDegraded',
          problem: result.problem,
          detail: result.detail,
        }));
      }
      if (now - failingSince < graceMs) {
        return { status: 'degraded', problem: result.problem, detail: result.detail };
      }
      if (!shutdownRequested) {
        shutdownRequested = true;
        console.error(JSON.stringify({
          event: 'InteractiveSidecarUnhealthy',
          problem: result.problem,
          detail: result.detail,
          failingForMs: now - failingSince,
        }));
        await deps.requestSidecarShutdown().catch((error) => {
          console.error(JSON.stringify({
            event: 'InteractiveSidecarShutdownFailed',
            detail: error instanceof Error ? error.message : String(error),
          }));
        });
      }
      return { status: 'unhealthy', problem: result.problem, detail: result.detail };
    },
  };
}

export function createDaprSidecarClient(daprHttpPort: string) {
  const base = `http://127.0.0.1:${daprHttpPort}/v1.0`;
  return {
    async fetchMetadata(): Promise<unknown> {
      const response = await fetch(`${base}/metadata`, {
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`metadata returned HTTP ${response.status}`);
      return response.json();
    },
    async requestSidecarShutdown(): Promise<void> {
      await fetch(`${base}/shutdown`, {
        method: 'POST',
        signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
      });
    },
  };
}

export function interactiveHealthRoute(
  check: () => Promise<InteractiveHealthReport>,
): (req: Request, res: Response) => Promise<void> {
  return async (_req, res) => {
    const report = await check();
    res.status(report.status === 'unhealthy' ? 503 : 200).json(report);
  };
}
