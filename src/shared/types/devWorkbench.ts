export interface AssignedWorkItem {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  assignedTo: string;
  project: string;
  areaPath?: string;
  iterationPath?: string;
  url?: string;
  /** Raw ADO System.Tags value (semicolon-separated). */
  tags?: string;
}

/**
 * ADO work-item states from which a development session may be started.
 * "Active" is the Bug equivalent of "In Progress". Any other state (e.g.
 * In Pull Request, Ready For Test, In Test, UAT states, Ready For Release)
 * disables Start Development. Done/Closed/Removed are already filtered out
 * of the assigned-work-items list upstream.
 */
export const DEV_START_ALLOWED_STATES: readonly string[] = [
  'New',
  'Approved',
  'Committed',
  'In Progress',
  'Active',
];

/** True when a work item in the given state is eligible for Start Development. */
export function canStartDevelopment(state: string | null | undefined): boolean {
  return !!state && DEV_START_ALLOWED_STATES.includes(state);
}

/**
 * Canonical tag stamped on every Feature that APEX creates in Azure DevOps
 * (both the in-app backlog export and the /to-work-items CLI skill). Its
 * presence signals the Feature carries the APEX-generated design docs an agent
 * needs as reference, and is what gates Start Development for non-admins.
 */
export const APEX_ORIGIN_TAG = 'apex';

/** True when the semicolon-separated System.Tags value contains the APEX origin tag. */
export function hasApexOriginTag(tags: string | null | undefined): boolean {
  if (!tags) return false;
  return tags
    .split(';')
    .map((t) => t.trim().toLowerCase())
    .includes(APEX_ORIGIN_TAG);
}

/** Result of a Start Development eligibility check for a single work item. */
export interface DevStartEligibility {
  allowed: boolean;
  /** Human-readable reason a disabled action is unavailable (tooltip copy). */
  reason?: string;
}

/**
 * Decides whether Start Development may be initiated for a work item.
 *
 * Rules:
 * - The item's state must be in {@link DEV_START_ALLOWED_STATES} (always).
 * - Super admins ("platform admins") may start any eligible-state item of any
 *   type, regardless of APEX origin.
 * - Everyone else may only start APEX-generated Features — i.e. work item type
 *   `Feature` carrying the {@link APEX_ORIGIN_TAG} — so the required design docs
 *   are available for reference. PBIs, TBIs, and Bugs must be started from their
 *   parent Feature.
 */
export function evaluateDevStartEligibility(
  item: Pick<AssignedWorkItem, 'workItemType' | 'state' | 'tags'>,
  opts: { isSuperAdmin: boolean },
): DevStartEligibility {
  if (!canStartDevelopment(item.state)) {
    return {
      allowed: false,
      reason: `Start Development is only available for ${DEV_START_ALLOWED_STATES.join(', ')} work items (current state: ${item.state || 'unknown'}).`,
    };
  }

  if (opts.isSuperAdmin) {
    return { allowed: true };
  }

  if (item.workItemType !== 'Feature') {
    return {
      allowed: false,
      reason: 'Start Development is only available on Features. Start PBIs, TBIs, and Bugs from their parent Feature.',
    };
  }

  if (!hasApexOriginTag(item.tags)) {
    return {
      allowed: false,
      reason: 'Start Development is only available on APEX-generated Features, which carry the design docs needed for reference.',
    };
  }

  return { allowed: true };
}

export interface BacklogFeatureItem {
  featureId: string;
  featureTitle: string;
  featurePriority: string;
  epicTitle: string;
  prdId: string;
  prdTitle: string;
  dependsOn: string[];
  designDocId?: string;
  designDocStatus?: string;
  itemCount: number;
  pbiCount: number;
  tbiCount: number;
}

export interface ApexBacklogGroup {
  prdId: string;
  prdTitle: string;
  epics: {
    epicTitle: string;
    features: BacklogFeatureItem[];
  }[];
}

export interface StartDevSessionRequest {
  workItemId?: number;
  project: string;
  model?: string;
  prdId?: string;
  featureId?: string;
}

export type DevSessionStatus = 'setting_up' | 'in_progress' | 'conflict' | 'failed' | 'closed' | 'completed';
export type DevSessionSetupPhase =
  | 'dependencies_preparing'
  | 'dependencies_waiting'
  | 'dependencies_ready'
  | 'dependencies_skipped'
  | 'dependencies_failed';

export interface StartDevSessionResponse {
  sessionId: string;
}

export interface DevSessionDetail {
  id: string;
  workItemId: number | null;
  chatThreadId: string | null;
  branchName: string | null;
  status: DevSessionStatus;
  setupError: string | null;
  setupPhase: DevSessionSetupPhase | null;
  setupDetail: string | null;
  setupProgressAt: string | null;
  prUrl: string | null;
  branchPushed: boolean;
  createdAt: string;
  prdId?: string | null;
  featureId?: string | null;
}

export interface ConflictedFile {
  path: string;
  content: string;
}

export interface PushSessionResponse {
  ok: boolean;
  /** Set when the merge produced conflicts — push and PR are blocked until resolved. */
  status: 'clean' | 'conflict';
  branch?: string;
  branchPushed?: boolean;
  conflictedFiles?: ConflictedFile[];
}

export interface CreatePrResponse {
  prUrl: string | null;
}

export interface DevDiff {
  diffText: string;
  changedFiles: string[];
  branch: string;
  branchPushed?: boolean;
}

export interface ActiveDevSession {
  id: string;
  workItemId: number | null;
  chatThreadId: string | null;
  branchName: string | null;
  status: DevSessionStatus;
  prUrl: string | null;
  createdAt: string;
  prdId?: string | null;
  featureId?: string | null;
}
