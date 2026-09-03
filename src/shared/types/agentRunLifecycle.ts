/**
 * Formal Agent Run Lifecycle vocabulary (FEAT-001).
 * Human-readable labels are rendered downstream in FEAT-006 (TBI-008).
 */

import type { SkillProvider } from './projectSettings';

export type AgentRunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Run lane for dispatched runs; NULL = legacy in-process.
 * - `background`: bounded ephemeral worker lane on the ai-runs-background Service Bus queue.
 * - `ai-runs-interactive`: warm Dapr virtual-actor lane on ACA (FEAT-007); never Service Bus.
 * - `cloud-agent`: vendor-executed Cloud Agent implementation run; never an Apex worker lane.
 */
export type AgentRunLane = 'background' | 'ai-runs-interactive' | 'cloud-agent';

/**
 * Closed workflow classification on agent_runs. NULL preserves legacy generation rows.
 */
export type AgentRunWorkflowClass = 'generation' | 'implementation';

/**
 * Closed terminal-reason set stored alongside domain status
 * `completed | failed | cancelled` (domain contract unchanged).
 */
export type AgentRunTerminalReason =
  | 'worker_lost'
  | 'progress_timeout'
  | 'queue_ttl'
  | 'forced_cancel'
  | 'cloud_agent_timeout';

export type AgentRunCancelState = 'requested' | 'acknowledged' | 'completed';

/** Pre-PR quality check reported by a Cloud Agent run (FEAT-003 TBI-005). */
export type RunCheckKind = 'unit' | 'e2e' | 'wcag';

export type RunCheckOutcome = 'passed' | 'failed';

/**
 * One suite-level check outcome captured when a run reaches a terminal state.
 * Suite granularity only — no raw test output, stack traces, or log excerpts.
 */
export interface RunCheckResult {
  kind: RunCheckKind;
  outcome: RunCheckOutcome;
}

/** Frozen at enqueue; never mutated (PBI-001 AC-d). */
export interface ExecutionSnapshot {
  prompt: string;
  model: string;
  /**
   * Writable Agent cwd (`.ai-pilot` scratch/outputs). For PRD/design-doc this is
   * the thin thread workspace — not a full repo clone.
   */
  workspaceRef: string;
  /**
   * Optional pinned shared read checkout for native repo tools. When set, the
   * worker opens LocalCheckoutReader here and must not treat workspaceRef as
   * the git tree. Omitted for legacy full-clone snapshots.
   */
  checkoutRef?: string;
  /**
   * Optional bare-mirror path for Stage 6 native reads. When set with
   * `groundedSha`, the worker opens BareRepoReader instead of a working tree.
   */
  mirrorRef?: string;
  /** SHA pinned for `mirrorRef` / BareRepoReader. */
  groundedSha?: string;
  /** Repository name for BareRepoReader / HTTP identity. */
  repository?: string;
  /** Provider for BareRepoReader / HTTP identity (`ado` | `github`). */
  provider?: SkillProvider;
  workflowClass: string;
  skillPath: string;
  projectId: string;
  threadId: string;
}

/** Accessible label map for lifecycle statuses (PBI-001 a11y NFR). */
export const AGENT_RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  queued: 'Queued — waiting for available worker',
  dispatched: 'Starting…',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const AGENT_RUN_TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export const AGENT_RUN_TERMINAL_REASONS: ReadonlySet<AgentRunTerminalReason> = new Set([
  'worker_lost',
  'progress_timeout',
  'queue_ttl',
  'forced_cancel',
  'cloud_agent_timeout',
]);

export function isAgentRunTerminalStatus(status: string): status is Extract<
  AgentRunStatus,
  'completed' | 'failed' | 'cancelled'
> {
  return AGENT_RUN_TERMINAL_STATUSES.has(status as AgentRunStatus);
}

export function isAgentRunTerminalReason(value: string): value is AgentRunTerminalReason {
  return AGENT_RUN_TERMINAL_REASONS.has(value as AgentRunTerminalReason);
}
