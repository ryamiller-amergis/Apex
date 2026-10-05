import type {
  GroundingSurface,
  RunGroundingStatus,
} from '../../shared/types/runGrounding';

export interface GroundingResumeGate {
  composerBlocked: boolean;
  showCard: boolean;
  status: RunGroundingStatus | null;
  continueOnPin: () => void;
  updateToLatest: () => Promise<void>;
  isUpdating: boolean;
  error: Error | null;
}

const IDLE_GATE: GroundingResumeGate = {
  composerBlocked: false,
  showCard: false,
  status: null,
  continueOnPin: () => undefined,
  updateToLatest: async () => undefined,
  isUpdating: false,
  error: null,
};

/**
 * Resume / update-to-latest cards are retired. Routine pin freshness is the
 * overnight idle re-ground pass; callers keep this hook so composer wiring
 * stays stable.
 */
export function useGroundingResumeGate(
  _surface: GroundingSurface,
  _domainRunId: string | null | undefined,
  _project: string | null | undefined,
  _isAgentRunning = false,
): GroundingResumeGate {
  return IDLE_GATE;
}
