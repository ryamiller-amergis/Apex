/**
 * Apex-vocabulary contracts for playbook orchestration.
 *
 * Everything the rest of Apex sends to, or receives from, the engine is described here. No type in
 * this file may be derived from an engine package: the wrapper exists so that swapping the engine
 * is a change inside `src/server/services/playbookEngine/` and nowhere else, and that only holds
 * while its signatures speak Apex's own language.
 *
 * The row shapes below mirror the four Apex-owned tables. They are the whole of what Apex needs to
 * answer "what happened, and what happens next" — the engine's own store is a disposable execution
 * cache, so nothing here may depend on it being present.
 */
import type { ZodType } from 'zod';
import type { ArtifactRef } from './loadTest';

// ── Status vocabularies ───────────────────────────────────────────────────────

/**
 * Lifecycle of a definition version. Only this column may move after publication; the graph itself
 * is frozen, which is what lets a run pin a version and trust it for days.
 */
export const PLAYBOOK_VERSION_STATUSES = ['draft', 'published', 'deprecated', 'archived'] as const;
export type PlaybookVersionStatus = (typeof PLAYBOOK_VERSION_STATUSES)[number];

/**
 * States a run can be observed in.
 *
 * `expired` is a peer of the other terminals rather than a flag on `failed` because the whole point
 * is distinguishing "nobody came" from "something broke" — an approval gate that timed out is not a
 * malfunction, and a status view that conflates them tells an operator the wrong story.
 */
export const PLAYBOOK_RUN_STATUSES = [
  'running',
  'suspended',
  'completed',
  'cancelled',
  'failed',
  'expired',
] as const;
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];

/**
 * States an individual step can be observed in.
 *
 * `failed_retryable` exists only here, not on the run: it is what a live agent step becomes when the
 * process dies mid-turn, and the ADR's exit criterion asks for manual retry of that step rather than
 * failure of the whole run. Cursor work cannot resume mid-turn, so the step is parked for a person
 * instead of being retried automatically.
 */
export const PLAYBOOK_STEP_RUN_STATUSES = [
  'pending',
  'running',
  'suspended',
  'completed',
  'failed',
  'failed_retryable',
  'cancelled',
  'expired',
] as const;
export type PlaybookStepRunStatus = (typeof PLAYBOOK_STEP_RUN_STATUSES)[number];

/**
 * Step states that are still waiting on something. The `expires_at` index is partial over exactly
 * this set, so the reconciliation sweep scans open suspensions rather than all run history.
 */
export const PLAYBOOK_STEP_RUN_OPEN_STATUSES = ['pending', 'running', 'suspended'] as const;

/** Why a run is parked. Both kinds resume through the same path, per BR-008. */
export type PlaybookSuspendReason = 'approval_gate' | 'agent_run';

// ── Definition graph ──────────────────────────────────────────────────────────

/**
 * A node's step type is a plain string here on purpose. The registry that decides which step types
 * exist, and what each one requires, is FEAT-004's contract — naming the three Phase 0 types in this
 * union would put the vocabulary in two places and make adding a fourth a shared-types change.
 */
export interface PlaybookGraphNode {
  id: string;
  stepType: string;
  config?: Record<string, unknown>;
}

export interface PlaybookGraphEdge {
  from: string;
  to: string;
  /** Branch conditions arrive in Phase 1, evaluated against a named prior step's output schema. */
  condition?: string;
}

/** The frozen content of a published version. Stored as `jsonb` on the version row. */
export interface PlaybookGraph {
  nodes: PlaybookGraphNode[];
  edges: PlaybookGraphEdge[];
}

// ── Row shapes (mirror the four Apex-owned tables) ────────────────────────────

/** A definition has identity that outlives any single version, which is why it is its own row. */
export interface PlaybookDefinition {
  id: string;
  project: string;
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookDefinitionVersion {
  id: string;
  definitionId: string;
  versionNumber: number;
  graph: PlaybookGraph;
  status: PlaybookVersionStatus;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
  /** Draft revision time; refreshed on draft save and when publish advances the retained draft. */
  updatedAt: string;
}

export interface PlaybookRun {
  id: string;
  project: string;
  /** A run never follows a version it did not start on. */
  definitionVersionId: string;
  /** The authorization identity for the whole run, per BR-003. */
  initiatorUserId: string;
  status: PlaybookRunStatus;
  /**
   * Documented reason when the caller explicitly pinned an older published version. Null when the
   * run resolved to the project's current published version.
   */
  versionPinReason: string | null;
  /**
   * Incremented by the runtime as steps execute, never computed on read. The structural guards in
   * FEAT-005 are synchronous, and making a synchronous guard depend on an aggregate scan is how
   * admission checks become slow enough to skip.
   */
  stepCount: number;
  agentStepCount: number;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookStepRun {
  id: string;
  runId: string;
  /** The node id within the pinned version's graph. */
  stepId: string;
  stepType: string;
  status: PlaybookStepRunStatus;
  /** Null for `approval-gate` and `notify` steps, which correlate to no agent run. */
  agentRunId: string | null;
  resumeToken: string | null;
  /** Phase 0 writes only this. */
  outputInline: Record<string, unknown> | null;
  /** Shaped now so the Phase 1 threshold decision costs no migration. */
  outputBlobRef: ArtifactRef | null;
  /** Every suspension has one; reconciliation ends the run as expired once it passes. */
  expiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Reconstruction projection ─────────────────────────────────────────────────

export interface PlaybookRunSummary {
  runId: string;
  project: string;
  definitionName: string;
  definitionVersionId: string;
  versionNumber: number;
  status: PlaybookRunStatus;
  initiatorUserId: string;
  startedAt: string;
  completedAt: string | null;
}

/**
 * Carries an accurate total alongside a capped page, because a status view that says "20 runs" when
 * there are 300 is worse than one that shows 20 and says so.
 */
export interface PlaybookRunListResult {
  runs: PlaybookRunSummary[];
  total: number;
}

/** What a suspended run is waiting on, and until when. Absent unless a step is actually parked. */
export interface PlaybookSuspensionDetail {
  stepId: string;
  reason: PlaybookSuspendReason;
  deadline: string | null;
}

/**
 * The answer to "what happened, and what happens next" — assembled from Apex tables alone. Exit
 * criterion E4 drops every engine table and asserts this is still correct.
 */
export interface PlaybookRunDetail extends PlaybookRunSummary {
  steps: PlaybookStepRun[];
  /** The step the run is currently on: the parked one, or the first that has not finished. */
  currentStepId: string | null;
  suspension: PlaybookSuspensionDetail | null;
}

// ── Step types ────────────────────────────────────────────────────────────────

/**
 * What a step type declares about itself.
 *
 * This file carries the *shape*; the registry in `src/server/services/playbookSteps/` carries the
 * values. That split is deliberate — TBI-016 requires the registry to be the only place a step type
 * is declared, so naming `cursor-agent` here would create a second declaration site and make adding
 * a fourth type a shared-types change.
 *
 * The union below encodes BR-005 in the type system: a descriptor that can suspend cannot be
 * written without a deadline, because a suspension with no deadline is a run that waits forever and
 * no sweep can ever end. The registry checks the same rule at runtime anyway — the type only
 * protects descriptors written as literals, and a descriptor assembled dynamically or widened
 * through a cast would slip past it.
 */
interface PlaybookStepTypeDescriptorBase {
  stepType: string;
  /**
   * Skill paths this step type may run. Empty or absent means the step type runs no Skill.
   *
   * Phase 0's enforcement of the PRD's read-only-Skill rule, and narrower than that rule sounds:
   * it constrains *which* Skills may be named, not what they are able to do. Apex has no read-only
   * capability model — `ExecutionSnapshot.skillPath` is a bare path and nothing reads SKILL.md
   * frontmatter — so a real check is not available to build against. Recorded as a gap for
   * FEAT-008 in `design-docs/playbook-epic-1-phase-0.plan.md`.
   *
   * Optional rather than modelled per step type because exactly one Phase 0 type runs a Skill, and
   * a per-type config union for a single case is a layer nobody reads.
   */
  allowedSkillPaths?: readonly string[];

  /**
   * Whether this type counts against the per-definition agent-step cap.
   *
   * Explicit rather than derived from `allowedSkillPaths`, which happens to identify the same
   * single type today. A future type could run a Skill without being an agent turn, or be one
   * without naming a Skill, and a guard that silently stopped counting would be discovered by an
   * unexpected bill rather than by a test.
   */
  isAgentStep: boolean;

  /**
   * What executing this step does outside its own row, in the PRD's vocabulary.
   *
   * Read by two rules. TBI-024 re-checks the initiator's permissions before any step that is not
   * `read`, and TBI-034 refuses to publish a graph where a `leaves-apex` node is reached from
   * anything but an `approval-gate`. Both read the classification in force now rather than the one
   * a version was published under, which is why it lives on the descriptor and not in the graph.
   */
  sideEffect: PlaybookStepSideEffect;

  /**
   * What the run initiator must hold for a step of this type to execute, per TBI-033.
   *
   * Non-empty by construction: a step type that names no permission would execute on whatever
   * authority admitted the run, which is how `playbooks:run` quietly becomes an umbrella for
   * effects nobody granted it for. A later step type declares its own domain permissions here
   * rather than inheriting these by convention. The registry re-checks emptiness at runtime too,
   * because a tuple is only non-empty while nobody has cast their way past it.
   */
  requiredPermissions: readonly [string, ...string[]];

  /**
   * What a graph node's `config` must contain for this step type, and what the step yields.
   *
   * Typed as Zod rather than as a TypeScript interface because both are read at runtime by things
   * that hold no compile-time type for the step: a node's stored `config`, an adapter's result on
   * its way to being recorded as complete, and — later — a gate rendering the input to an approver
   * and a branch condition evaluated against the output.
   *
   * Retrievable by step-type key from the registry, so inspecting what a step type takes and
   * returns never involves instantiating an adapter or starting anything.
   */
  inputSchema: ZodType<Record<string, unknown>>;
  outputSchema: ZodType<Record<string, unknown>>;
}

/**
 * `read` is a step whose only trace is its own step-run row — a gate waiting on a person records a
 * decision and nothing else. `writes-apex` changes Apex state a user can see. `leaves-apex` reaches
 * a system Apex does not own, which cannot be rolled back by anything here and is therefore the
 * only classification that mandates an approval gate in front of it.
 */
export const PLAYBOOK_STEP_SIDE_EFFECTS = ['read', 'writes-apex', 'leaves-apex'] as const;
export type PlaybookStepSideEffect = (typeof PLAYBOOK_STEP_SIDE_EFFECTS)[number];

export type PlaybookStepTypeDescriptor =
  | (PlaybookStepTypeDescriptorBase & {
      canSuspend: true;
      /** Required. How long the step waits before the sweep ends the run as expired. */
      defaultDeadlineMs: number;
      /** Whether a definition may shorten or extend the default for a particular step. */
      deadlineOverridable: boolean;
      /**
       * What ends the wait — a person or a machine. Both resume through the same primitive
       * (BR-008), so this is not a branch in the execution path; it is what the status view reads
       * to tell an operator whether to go find someone or go look at a queue.
       */
      suspendReason: PlaybookSuspendReason;
    })
  | (PlaybookStepTypeDescriptorBase & {
      canSuspend: false;
      defaultDeadlineMs?: never;
      deadlineOverridable?: never;
      suspendReason?: never;
    });

// ── Per-step-type configuration ───────────────────────────────────────────────
//
// What a graph node's `config` carries for each production step type, for callers that hold the
// config at compile time. The authority is the descriptor's `inputSchema` in the registry, which is
// what actually validates a stored node config; these interfaces mirror it and nothing more.

export interface CursorAgentStepConfig {
  /** Checked against the descriptor's `allowedSkillPaths` before anything is enqueued. */
  skillPath: string;
  prompt: string;
  model?: string;
}

export interface ApprovalGateStepConfig {
  /** Overrides the descriptor's 48-hour default for this step only. */
  deadlineMs?: number;
  /** Shown to whoever is deciding. */
  subject?: string;
}

export interface NotifyStepConfig {
  title: string;
  body?: string;
  link?: string;
  /** Defaults to the run initiator, who is the only identity Phase 0 can resolve (BR-003). */
  recipientUserId?: string;
}

// ── Structural guards ─────────────────────────────────────────────────────────

/**
 * The six caps, split by when they can be known.
 *
 * Graph shape is fixed at publication, so checking it per run would re-derive an answer that cannot
 * have changed. Concurrency depends on what is happening right now, so it can only be checked at
 * admission. Every value lives here rather than in the service because the refusal messages name
 * the cap, and a client that formats one should not be quoting a different number from the server
 * that enforces it.
 *
 * None of these are read from cost data, per BR-007. That is asserted by VT-18 rather than left to
 * the reader, because a guard that quietly grew a network call is the failure this rule exists to
 * prevent.
 */
export const PLAYBOOK_GUARD_LIMITS = {
  /** Publish-time. */
  maxStepsPerRun: 20,
  /** Publish-time. Agent steps cost far more than the others, so they get a tighter ceiling. */
  maxAgentStepsPerRun: 10,
  /** Publish-time. One means no fan-out at all in Phase 0 — a linear graph. */
  maxFanOutWidth: 1,
  /** Admission-time, per project. */
  maxActiveRunsPerProject: 5,
  /**
   * Admission-time, per project, and deliberately a separate counter from the active-run cap.
   *
   * Counting suspensions against concurrency would let a handful of abandoned runs lock a project
   * out of starting anything; not counting them at all would let a graph that suspends escape the
   * only bound there is. Two counters is the only arrangement that avoids both.
   */
  maxSuspendedRunsPerProject: 20,
} as const;

export type PlaybookGuardLimits = typeof PLAYBOOK_GUARD_LIMITS;

/**
 * Which guard refused, so a caller can react to the kind rather than parsing the message.
 *
 * `ungated-leaves-apex` is not a cap like the others — nothing about it is a number. It is here
 * because it refuses a graph at the same moment and through the same path as the caps do, and a
 * caller that already branches on this vocabulary should not need a second one to learn that
 * publication was refused.
 */
export type PlaybookGuardViolationKind =
  | 'max-steps'
  | 'max-agent-steps'
  | 'max-fan-out'
  | 'loop'
  | 'active-run-cap'
  | 'suspended-run-ceiling'
  | 'ungated-leaves-apex';

export interface PlaybookGuardViolation {
  kind: PlaybookGuardViolationKind;
  /** Names the cap and the observed value. Surfaced to the caller verbatim. */
  message: string;
}

// ── Gate decisions ────────────────────────────────────────────────────────────

export type PlaybookGateDecision = 'approve' | 'reject';

export interface PlaybookGateDecisionRequest {
  decision: PlaybookGateDecision;
  comment?: string;
}

export interface PlaybookGateDecisionResponse {
  runId: string;
  status: PlaybookRunStatus;
  /** Absent when the decision was a duplicate and moved nothing. */
  resumedStepId?: string;
  /**
   * True when this call is what advanced the run. A duplicate returns `false` with a 200 rather
   * than an error: the caller asked for a decided gate and the gate is decided.
   */
  advanced: boolean;
}

// ── Reconciliation sweep ──────────────────────────────────────────────────────

/**
 * What one sweep pass did.
 *
 * TBI-021's definition of done requires the last-run outcome to be observable, and the reason is
 * worth stating: a sweep that silently stopped running looks exactly like a sweep with nothing to
 * do. Both report zero. Only the timestamp distinguishes them.
 */
export interface PlaybookSweepOutcome {
  startedAt: string;
  durationMs: number;
  /** Steps whose agent run had finished but whose terminal event never arrived. */
  resumed: number;
  /** Steps past `expires_at`, moved to `expired`. */
  expired: number;
  /** Steps with no path forward — suspended with neither a deadline nor a correlated agent run. */
  orphaned: number;
  /**
   * Runs that were settled but unfinished — every step completed, none started for the next one.
   * A steady non-zero count here means advances are being missed on the latency path rather than
   * merely arriving late, since anything the route or the event listener handles never reaches
   * this pass.
   */
  advanced: number;
  /** Present when the pass threw. The scheduler keeps ticking; one bad pass is not fatal. */
  error?: string;
}

// ── Engine wrapper operations ─────────────────────────────────────────────────

/**
 * Carried by every operation. The initiator is the authorization identity for the whole run
 * (BR-003), so it is the identity each operation is evaluated against — not whoever happens to be
 * driving this particular call.
 */
export interface PlaybookOperationContext {
  projectName: string;
  initiatorUserId: string;
}

/**
 * Every engine operation carries the run id and the pinned graph.
 *
 * The graph is passed rather than looked up because Apex has already read it — a run is admitted,
 * capacity-checked and pinned to a version before an engine is involved, and re-reading the version
 * row inside the engine would be a second query for an answer the caller is holding. It also keeps
 * the engine free of Apex's schema, which is what lets it be replaced without a migration.
 */
export interface PlaybookEngineInput extends PlaybookOperationContext {
  runId: string;
  /** The frozen graph of the version this run is pinned to, for its whole life. */
  graph: PlaybookGraph;
}

export interface PlaybookStartInput extends PlaybookEngineInput {
  /** The immutable published version being run. A run never follows a version it did not start on. */
  definitionVersionId: string;
  input?: Record<string, unknown>;
}

export interface PlaybookResumeInput extends PlaybookEngineInput {
  /** The graph node whose step has been resolved. */
  stepId: string;
  /**
   * Who resolved the step, when a person did. The approver permits continuation but does not lend
   * authority — the run keeps the initiator's identity, so this records who decided, not who the
   * run acts as.
   *
   * Absent when nobody decided anything: a terminal agent-run event and the reconciliation sweep
   * both resume runs with no person behind the call, and naming one would be a fiction.
   */
  resolvedByUserId?: string;
  output?: Record<string, unknown>;
}

export interface PlaybookCancelInput extends PlaybookEngineInput {
  cancelledByUserId: string;
  reason?: string;
}

/** Re-executes one retryable row without changing run identity or its pinned version. */
export interface PlaybookRetryInput extends PlaybookEngineInput {
  definitionVersionId: string;
  stepRunId: string;
  stepId: string;
  retriedByUserId: string;
}

export interface CancelPlaybookRunRequest {
  project: string;
  reason?: string;
}

export interface CancelPlaybookRunResponse {
  runId: string;
  status: 'cancelled';
  outcome: 'cancelled' | 'already-cancelled';
}

export interface RetryPlaybookStepRequest {
  project: string;
}

export interface RetryPlaybookStepResponse {
  runId: string;
  stepRunId: string;
  status: 'running';
  outcome: 'retried';
}

// ── Definition lifecycle API contracts (FEAT-007) ─────────────────────────────
//
// Thin Apex-vocabulary DTOs for draft/publish/deprecate and run-version pin resolution. No engine
// types appear here: the service layer speaks these shapes on both sides of the HTTP boundary.

/** Definition list row without graph payloads. */
export interface PlaybookDefinitionSummary {
  id: string;
  project: string;
  name: string;
  description: string | null;
  draftUpdatedAt: string;
  currentPublishedVersionNumber: number | null;
}

/** The sole mutable working copy for a definition. */
export interface PlaybookDefinitionDraft {
  id: string;
  definitionId: string;
  /** Candidate number the next successful publish will freeze. */
  nextVersionNumber: number;
  graph: PlaybookGraph;
  updatedAt: string;
}

/** Immutable history row for lifecycle actions and the version list. */
export interface PlaybookPublishedVersionSummary {
  id: string;
  definitionId: string;
  versionNumber: number;
  status: PlaybookVersionStatus;
  publishedBy: string | null;
  publishedAt: string | null;
}

export interface PlaybookDefinitionListResult {
  definitions: PlaybookDefinitionSummary[];
}

/** Definition editor read model: identity, retained draft, and numbered history. */
export interface PlaybookDefinitionDetail {
  definition: PlaybookDefinition;
  draft: PlaybookDefinitionDraft;
  versions: PlaybookPublishedVersionSummary[];
  currentPublishedVersionId: string | null;
}

export interface PlaybookDefinitionDraftResponse {
  definition: PlaybookDefinition;
  draft: PlaybookDefinitionDraft;
}

/** Confirms both the frozen published copy and the retained working draft. */
export interface PlaybookPublishResponse {
  publishedVersion: PlaybookPublishedVersionSummary;
  draft: PlaybookDefinitionDraft;
  currentPublishedVersionId: string;
}

export interface PlaybookDeprecateVersionResponse {
  version: PlaybookPublishedVersionSummary;
  currentPublishedVersionId: string | null;
}

/**
 * Start a run against a project-scoped definition. An explicit pin requires both
 * `definitionVersionId` and a non-blank `versionPinReason`.
 */
export interface StartRunRequest {
  project: string;
  definitionId: string;
  definitionVersionId?: string;
  versionPinReason?: string;
}

/** Makes the resolved version pin visible to the caller. */
export interface StartRunResult {
  runId: string;
  status: PlaybookRunStatus;
  definitionVersionId: string;
}
