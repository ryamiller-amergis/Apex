/**
 * Apex-vocabulary contracts for the playbook engine wrapper.
 *
 * Everything the rest of Apex sends to, or receives from, the engine is described here. No type in
 * this file may be derived from an engine package: the wrapper exists so that swapping the engine
 * is a change inside `src/server/services/playbookEngine/` and nowhere else, and that only holds
 * while its signatures speak Apex's own language.
 */

/** Terminal and non-terminal states a run can be observed in. */
export type PlaybookRunStatus =
  | 'running'
  | 'suspended'
  | 'succeeded'
  | 'failed'
  | 'failed_retryable'
  | 'cancelled'
  | 'expired';

/** Why a run is parked. Both kinds resume through the same path, per BR-008. */
export type PlaybookSuspendReason = 'approval_gate' | 'agent_run';

/**
 * What the caller holds after any operation. Apex owns run truth, so this carries Apex's run id —
 * the engine's own position is an implementation detail of the wrapper.
 */
export interface PlaybookRunHandle {
  runId: string;
  status: PlaybookRunStatus;
  /** The immutable published version the run is pinned to for its whole life. */
  definitionVersionId: string;
  /** Present only while `status` is `suspended`. */
  suspendedStepId?: string;
  /** When a suspended step stops waiting and the run expires. */
  deadline?: string;
}

/**
 * Carried by every operation. The initiator is the authorization identity for the whole run
 * (BR-003), so it is the identity each operation is evaluated against — not whoever happens to be
 * driving this particular call.
 */
export interface PlaybookOperationContext {
  projectName: string;
  initiatorUserId: string;
}

export interface PlaybookStartInput extends PlaybookOperationContext {
  /** The immutable published version to run. A run never follows a version it did not start on. */
  definitionVersionId: string;
  input?: Record<string, unknown>;
}

export interface PlaybookSuspendInput extends PlaybookOperationContext {
  runId: string;
  stepId: string;
  reason: PlaybookSuspendReason;
  /** Every suspension has one. Reconciliation ends the run as expired once it passes. */
  deadline: string;
}

export interface PlaybookResumeInput extends PlaybookOperationContext {
  runId: string;
  stepId: string;
  /**
   * The approver permits continuation but does not lend authority — the run keeps the initiator's
   * identity, so this records who decided, not who the run acts as.
   */
  resolvedByUserId: string;
  output?: Record<string, unknown>;
}

export interface PlaybookCancelInput extends PlaybookOperationContext {
  runId: string;
  cancelledByUserId: string;
  reason?: string;
}
