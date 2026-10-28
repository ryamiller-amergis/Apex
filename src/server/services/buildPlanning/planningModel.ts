import type { PlanValidationResult, PlanViolation } from '../../../shared/buildPlanSchema';
import type { BuildPlan } from '../../../shared/buildPlanSchema';
import {
  planInvalidNotice,
} from '../../../shared/buildPlanCopy';
import { PLANNER_STOPPED_MESSAGE } from './plannerResult';
import type {
  BuildClassification,
  BuildRequirement,
  BuildRiskDecision,
  BuildRunStatus,
  BuildSkillSnapshot,
  BuildSupportContact,
  BuildSuspendReason,
  BuildTaskStatus,
} from '../../../shared/types/build';

export interface PlannerTaskState {
  id: string;
  status: BuildTaskStatus;
  attempt: number;
  agentRunId: string | null;
  /** While `ready`, when the launch began. While `running`, when the agent started. */
  startedAtMs: number | null;
}

/** A `ready` planner older than this is treated as a launch that died mid-way. */
export const PLANNER_READY_STALE_MS = 10 * 60 * 1000;

export function guardMatches(view: PlanningView, guard: PlanningGuard): boolean {
  if (!guard.runStatuses.includes(view.status)) return false;
  if (guard.planner === undefined) return true;
  if (guard.planner === null) return view.planner === null;
  return view.planner?.status === guard.planner.status && view.planner.attempt === guard.planner.attempt;
}

export function plannerGuard(planner: PlannerTaskState | null): PlanningGuard['planner'] {
  return planner ? { status: planner.status, attempt: planner.attempt } : null;
}

/** True when a launch for this planner is in progress or its agent is working. */
export function plannerInFlight(planner: PlannerTaskState | null, nowMs: number): boolean {
  if (!planner) return false;
  if (planner.status === 'running') return true;
  if (planner.status !== 'ready') return false;
  return planner.startedAtMs != null && nowMs - planner.startedAtMs < PLANNER_READY_STALE_MS;
}

export interface PlanningView {
  buildRunId: string;
  project: string;
  repository: string;
  requestedByUserId: string;
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
  suspendedFromStatus: BuildRunStatus | null;
  integrationBranch: string | null;
  baseCommit: string | null;
  skillSnapshot: BuildSkillSnapshot;
  supportContacts: BuildSupportContact[];
  revisionId: string;
  revisionNumber: number;
  classification: BuildClassification | null;
  requirements: BuildRequirement[];
  riskDecisions: BuildRiskDecision[];
  plan: unknown | null;
  planValidation: { status: 'pass' | 'fail'; violations: PlanViolation[] } | null;
  repairAttempts: number;
  contextNotesPath: string | null;
  briefText: string;
  planner: PlannerTaskState | null;
  planTasks: StoredPlanTask[];
  implementerCount: number;
}

export interface StoredPlanTask {
  taskKey: string;
  role: BuildPlan['tasks'][number]['role'];
  blockers: string[];
  ownedFiles: string[];
  covers: string[];
  reuse: BuildPlan['tasks'][number]['reuse'];
  runMode: BuildPlan['tasks'][number]['runMode'];
  chainHeadKey: string | null;
}

export interface PlanningPatch {
  status?: BuildRunStatus;
  suspendReason?: BuildSuspendReason | null;
  suspendedFromStatus?: BuildRunStatus | null;
  plan?: unknown | null;
  planValidation?: PlanningView['planValidation'];
  repairAttempts?: number;
  contextNotesPath?: string | null;
  planner?: PlannerTaskState | null;
  implementerCount?: number;
  tasks?: StoredPlanTask[];
}

export interface PlanningEvent {
  eventType: string;
  message: string;
  detail?: Record<string, unknown>;
  severity?: 'info' | 'warn' | 'error';
  dedupeKey?: string;
}

export interface PlanningWrite {
  runStatus?: BuildRunStatus;
  suspendReason?: BuildSuspendReason | null;
  suspendedFromStatus?: BuildRunStatus | null;
  plan?: unknown | null;
  planValidation?: PlanningView['planValidation'];
  contextNotesPath?: string | null;
  /** Set the counter to this value. Ignored when `incrementRepair` is set. */
  repairAttempts?: number;
  /** Add 1 when the current value is below 2. The write is dropped when the cap is already 2. */
  incrementRepair?: boolean;
  planner?: PlannerTaskState;
  tasks?: StoredPlanTask[];
  events?: PlanningEvent[];
}

/** What the run and planner must still look like, under the run row lock, for a write to apply. */
export interface PlanningGuard {
  runStatuses: readonly BuildRunStatus[];
  /** Null means no planner row yet. Omit to skip the planner check. */
  planner?: { status: BuildTaskStatus; attempt: number } | null;
}

export interface PlanningStore {
  load(buildRunId: string, revisionNumber?: number): Promise<PlanningView | null>;
  apply(buildRunId: string, write: PlanningWrite): Promise<PlanningView>;
  /** Applies the write only when the guard still matches. Returns null otherwise. */
  applyIf(buildRunId: string, guard: PlanningGuard, write: PlanningWrite): Promise<PlanningView | null>;
  /**
   * Applies the write only when the run is `planning` and the planner task is
   * `running` for this agent run. Returns null when another completion already
   * claimed it, or the run moved on.
   */
  claimAndApply(
    buildRunId: string,
    agentRunId: string,
    write: PlanningWrite,
  ): Promise<PlanningView | null>;
}

export interface PlannerLaunchRequest {
  buildRunId: string;
  project: string;
  repository: string;
  prompt: string;
  model: string;
  skillPath: string;
  skillHash: string;
  startingRef: string;
  integrationBranch: string;
  plannerTaskId: string;
  attempt: number;
}

export interface PlannerLaunchResult {
  agentRunId: string;
}

export type PlanningStartResult =
  | { status: 'launched'; attempt: number }
  | { status: 'small_path' }
  | { status: 'already_planned' }
  /** The run is not in a state planning can start from. Nothing was changed. */
  | { status: 'not_planning'; runStatus: BuildRunStatus; suspendReason: BuildSuspendReason | null }
  | { status: 'refused'; reason: 'flag_disabled' | 'permission_revoked' | 'configuration' };

export type PlanningCompletionResult =
  | { status: 'validated' }
  | { status: 'repair_requested'; attempt: number }
  | { status: 'suspended'; reason: 'plan_invalid' | 'flag_disabled' | 'permission_revoked' | 'configuration' }
  /** The plan file could not be read. Nothing was changed; call again later. */
  | { status: 'deferred' }
  | { status: 'ignored' };

export type AgentRunOutcome = 'completed' | 'failed' | 'cancelled';

export function contactNames(view: PlanningView): string[] {
  return view.supportContacts.map((contact) => contact.displayName);
}

export function focusedError(violations: PlanViolation[], contacts: readonly string[]): {
  kind: 'validation' | 'stopped';
  message: string;
} {
  const stopped = violations.length > 0 && violations.every((row) => row.message === PLANNER_STOPPED_MESSAGE);
  const notice = planInvalidNotice({
    kind: stopped ? 'stopped' : 'validation',
    contacts,
  });
  const shown = violations.slice(0, 5).map((row) => row.message);
  const rest = violations.length - shown.length;
  const detail = rest > 0 ? `${shown.join(' ')} and ${rest} more.` : shown.join(' ');
  return {
    kind: stopped ? 'stopped' : 'validation',
    message: detail ? `${notice} ${detail}` : notice,
  };
}

export function toStoredTasks(plan: BuildPlan): StoredPlanTask[] {
  const byKey = new Map(plan.tasks.map((task) => [task.key, task]));
  return plan.tasks.map((task) => ({
    taskKey: task.key,
    role: task.role,
    blockers: [...task.blockers],
    ownedFiles: [...task.ownedFiles],
    covers: [...task.covers],
    reuse: task.reuse.map((entry) => ({ ...entry })),
    runMode: task.runMode,
    chainHeadKey: task.runMode === 'chain' ? chainHeadOf(task.key, byKey) : null,
  }));
}

/** Follows chain-mode blockers back to the chain task that waits on no other chain task. */
function chainHeadOf(key: string, byKey: Map<string, BuildPlan['tasks'][number]>): string {
  const seen = new Set<string>();
  let current = key;
  for (;;) {
    seen.add(current);
    const task = byKey.get(current);
    const previous = task?.blockers.find((blocker) => byKey.get(blocker)?.runMode === 'chain' && !seen.has(blocker));
    if (!previous) return current;
    current = previous;
  }
}

export function expectedClassification(
  revision: BuildClassification | null,
  source: 'planner' | 'small_agent' | 'escalation',
): BuildClassification {
  if (source === 'escalation') return 'full';
  if (source === 'small_agent') return 'small';
  return revision === 'small' ? 'small' : 'full';
}

export function validationRecord(result: PlanValidationResult): PlanningView['planValidation'] {
  if (result.ok) return { status: 'pass', violations: [] };
  return { status: 'fail', violations: result.violations };
}

export function plannerRoleReady(snapshot: BuildSkillSnapshot): boolean {
  const role = snapshot.planner;
  return Boolean(role.model.trim() && role.skillPath.trim() && role.contentHash.trim());
}
