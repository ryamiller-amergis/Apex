import { useCallback, useState } from 'react';
import {
  isGroundingBehind,
  type GroundingSurface,
  type RunGroundingStatus,
} from '../../shared/types/runGrounding';
import { useFeatureFlag } from './useFeatureFlags';
import { useRunGrounding } from './useRunGrounding';

const FLAG_KEY = 'repo-grounding-workspace-profile';

function ackKey(
  surface: GroundingSurface,
  domainRunId: string,
  groundedSha: string,
): string {
  return `apex:grounding-resume:${surface}:${domainRunId}:${groundedSha}`;
}

function readAck(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeAck(key: string): void {
  try {
    sessionStorage.setItem(key, '1');
  } catch {
    // Private mode / disabled storage must not block chatting.
  }
}

export interface GroundingResumeGate {
  composerBlocked: boolean;
  showCard: boolean;
  status: RunGroundingStatus | null;
  continueOnPin: () => void;
  updateToLatest: () => Promise<void>;
  isUpdating: boolean;
  error: Error | null;
}

export function useGroundingResumeGate(
  surface: GroundingSurface,
  domainRunId: string | null | undefined,
  project: string | null | undefined,
  isAgentRunning = false,
): GroundingResumeGate {
  const flagEnabled = useFeatureFlag(FLAG_KEY, project ?? undefined);
  const [ackNonce, setAckNonce] = useState(0);
  const grounding = useRunGrounding(surface, domainRunId ?? '', {
    enabled: flagEnabled && Boolean(domainRunId),
  });
  const status =
    grounding.statuses.find((item) => item.role === 'target') ?? null;
  const acknowledged =
    status && domainRunId
      ? readAck(ackKey(surface, domainRunId, status.groundedSha))
      : false;
  const behind = status ? isGroundingBehind(status) : false;
  // Routine commit drift is handled by the nightly idle re-ground pass.
  // Only surface a non-blocking hard-checkpoint notice (14+ days).
  const hardCheckpoint = status?.stalenessState === 'hard-checkpoint';
  const showCard =
    flagEnabled &&
    !isAgentRunning &&
    Boolean(domainRunId) &&
    hardCheckpoint &&
    behind &&
    !acknowledged &&
    !grounding.isLoading &&
    !grounding.isError;
  void ackNonce;

  const continueOnPin = useCallback(() => {
    if (!status || !domainRunId) return;
    writeAck(ackKey(surface, domainRunId, status.groundedSha));
    setAckNonce((value) => value + 1);
  }, [domainRunId, status, surface]);

  const updateToLatest = useCallback(async () => {
    if (!status || !domainRunId) return;
    await grounding.reGround(status.role);
    writeAck(ackKey(surface, domainRunId, status.groundedSha));
    setAckNonce((value) => value + 1);
  }, [domainRunId, grounding, status, surface]);

  return {
    // Never block the composer on routine drift — nightly re-ground keeps pins fresh.
    composerBlocked: false,
    showCard,
    status,
    continueOnPin,
    updateToLatest,
    isUpdating: grounding.isReGrounding,
    error: grounding.reGroundError,
  };
}
