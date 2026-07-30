import type { ActiveDevSession, BacklogFeatureItem } from '../types/devWorkbench';

/** Development lifecycle status for Apex My Work (feature / epic / PRD). */
export type MyWorkStatus = 'ready' | 'in_progress' | 'complete';

export interface FeatureWorkStatus {
  state: MyWorkStatus;
  /** ISO timestamp when the feature entered the current status. */
  statusAt: string | null;
  /** Unmet dependency feature id, if any (does not change primary status). */
  blockedBy?: string;
  sessionId?: string;
  /** True when an active cloud session (with chat thread) exists. */
  hasCloudSession: boolean;
  /** True when the active session has a PR URL (still In Progress for rollup). */
  hasPr: boolean;
}

export interface RolledUpWorkStatus {
  state: MyWorkStatus;
  statusAt: string | null;
}

const ACTIVE_SESSION_STATUSES = new Set(['setting_up', 'in_progress', 'conflict']);

function sessionsForFeature(
  feature: Pick<BacklogFeatureItem, 'featureId' | 'prdId'>,
  sessions: ActiveDevSession[],
): ActiveDevSession[] {
  return sessions.filter((s) => s.featureId === feature.featureId && s.prdId === feature.prdId);
}

/**
 * Derives Ready / In Progress / Complete for a single Apex backlog feature.
 *
 * - Ready: no active or completed session (appears in My Work when PRD is approved)
 * - In Progress: Start Local or Start Development (active non-terminal session)
 * - Complete: Mark Complete (completed session)
 *
 * Closing a session (without completing) returns the feature to Ready.
 * In PR is treated as In Progress for status/rollup purposes.
 */
export function computeFeatureWorkStatus(
  feature: Pick<BacklogFeatureItem, 'featureId' | 'prdId' | 'dependsOn' | 'readyAt'>,
  sessions: ActiveDevSession[],
  allSessions: ActiveDevSession[] = sessions,
): FeatureWorkStatus {
  const matching = sessionsForFeature(feature, sessions);

  const completed = matching.find((s) => s.status === 'completed');
  if (completed) {
    return {
      state: 'complete',
      statusAt: completed.updatedAt ?? completed.createdAt,
      sessionId: completed.id,
      hasCloudSession: false,
      hasPr: false,
    };
  }

  const activeCloud = matching.find(
    (s) => ACTIVE_SESSION_STATUSES.has(s.status) && !!s.chatThreadId,
  );
  const active = activeCloud ?? matching.find((s) => ACTIVE_SESSION_STATUSES.has(s.status));
  if (active) {
    return {
      state: 'in_progress',
      statusAt: active.createdAt,
      sessionId: active.id,
      hasCloudSession: !!active.chatThreadId,
      hasPr: !!active.prUrl,
    };
  }

  let blockedBy: string | undefined;
  if (feature.dependsOn.length > 0) {
    for (const dep of feature.dependsOn) {
      const depDone = allSessions.find((s) => s.featureId === dep && s.status === 'completed');
      if (!depDone) {
        blockedBy = dep;
        break;
      }
    }
  }

  return {
    state: 'ready',
    statusAt: feature.readyAt ?? null,
    blockedBy,
    hasCloudSession: false,
    hasPr: false,
  };
}

/**
 * Rolls child statuses up to an Epic or PRD.
 *
 * - All Complete → Complete (timestamp = when the last child completed)
 * - All Ready → Ready (timestamp = earliest child Ready time)
 * - Otherwise → In Progress, including Ready+Complete with no In Progress child
 *   (partial completion means the parent is underway)
 *   Timestamp = earliest among In Progress children, else earliest Complete child
 */
export function rollupWorkStatus(
  children: Array<Pick<FeatureWorkStatus, 'state' | 'statusAt'>>,
): RolledUpWorkStatus {
  if (children.length === 0) {
    return { state: 'ready', statusAt: null };
  }

  const allComplete = children.every((c) => c.state === 'complete');
  if (allComplete) {
    return { state: 'complete', statusAt: maxIso(children.map((c) => c.statusAt)) };
  }

  const allReady = children.every((c) => c.state === 'ready');
  if (allReady) {
    return { state: 'ready', statusAt: minIso(children.map((c) => c.statusAt)) };
  }

  const inProgressAts = children.filter((c) => c.state === 'in_progress').map((c) => c.statusAt);
  if (inProgressAts.length > 0) {
    return { state: 'in_progress', statusAt: minIso(inProgressAts) };
  }

  // Mix of Ready + Complete (no In Progress) → In Progress
  const completeAts = children.filter((c) => c.state === 'complete').map((c) => c.statusAt);
  return { state: 'in_progress', statusAt: minIso(completeAts) };
}

function minIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => !!v);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a < b ? a : b));
}

function maxIso(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((v): v is string => !!v);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a > b ? a : b));
}

export function formatMyWorkStatusLabel(state: MyWorkStatus): string {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'in_progress':
      return 'In Progress';
    case 'complete':
      return 'Complete';
  }
}
