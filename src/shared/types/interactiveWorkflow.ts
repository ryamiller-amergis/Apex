/**
 * FEAT-007 Phase 2 — Real-Time Interactive Agent Transport.
 *
 * Shared contracts for the interactive lane (WebSocket gateway + Dapr virtual
 * actors on ACA). Interactive turns are dispatched IN-CLUSTER (never through
 * Service Bus, BR-013); reserved warm actor capacity is isolated from the
 * background lane (BR-014); over-capacity turns shed immediately to the
 * in-process path rather than queuing.
 */

/** DB lane value carried on `agent_runs.lane` for interactive turns. */
export const INTERACTIVE_LANE = 'ai-runs-interactive' as const;

/** Feature flag gating the interactive routing seam (default-off, fail-closed). */
export const INTERACTIVE_WORKFLOW_FLAG = 'ai-runs-interactive' as const;

/**
 * Interactive workflow classes reused as feature-flag `caller` values for
 * per-workflow targeting (extends the Phase 1 caller-based scheme — no new
 * FlagRuleType). Resolves assumptions.md item "Interactive workflow-class
 * taxonomy for flag targeting".
 */
export type InteractiveWorkflowClass =
  | 'interview'
  | 'adr'
  | 'home-chat'
  | 'ask-apex'
  | 'assistant';

export const INTERACTIVE_WORKFLOW_CLASSES: readonly InteractiveWorkflowClass[] = [
  'interview',
  'adr',
  'home-chat',
  'ask-apex',
  'assistant',
] as const;

/** Which warm-capacity band an admitted activation consumed. */
export type InteractiveActorSlot = 'reserved' | 'burst';

/**
 * Outcome of a reserved-capacity actor activation admission (TBI-010).
 * `admitted` fills reserved first then burst; over-capacity or a lost race
 * both shed to the in-process path (never an unbounded queue wait, BR-014).
 */
export type InteractiveAdmissionDecision =
  | {
      admitted: true;
      shed: false;
      slot: InteractiveActorSlot;
      dispatchMessageId: string;
      interactiveInFlight: number;
      reserved: number;
      burstMax: number;
    }
  | {
      admitted: false;
      shed: true;
      reason: 'over-capacity' | 'race-lost';
      interactiveInFlight: number;
      reserved: number;
      burstMax: number;
    };

/**
 * Result of the fail-closed interactive routing seam (TBI-012). `actor` is the
 * only path that dispatches in-cluster; every other outcome (disabled, eval
 * error, shed, race) routes the turn in-process (BR-017).
 */
export type InteractiveRouteDecision =
  | {
      route: 'actor';
      runId: string;
      dispatchMessageId: string;
      slot: InteractiveActorSlot;
    }
  | {
      route: 'in-process';
      reason:
        | 'flag-disabled'
        | 'flag-evaluation-error'
        | 'shed'
        | 'race-lost';
    };

/** Warm-capacity sizing (env-tunable; agrees with ACA actor min_replicas). */
export type InteractiveCapacity = Readonly<{
  reserved: number;
  burstMax: number;
}>;

/** First-token SLO evaluation output for agent-health + alerting (PBI-007 h). */
export type InteractiveSloStatus = 'ok' | 'breach' | 'unknown';

export type InteractiveTierHealth = Readonly<{
  /** interactiveInFlight / (reserved + burstMax); 1 means fully saturated. */
  interactiveSaturation: number;
  firstTokenSloStatus: InteractiveSloStatus;
  /** True when telemetry should raise an alert (SLO breach or reserved exhaustion). */
  alert: boolean;
}>;
