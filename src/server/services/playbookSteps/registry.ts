/**
 * The only place a Playbook step type is declared.
 *
 * TBI-016 asks for the smallest registry that works, and the smallest thing that works is a map
 * built from three literals at module load. There is no discovery, no plugin scan and no dynamic
 * registration: a closed set validated up front, in the spirit of `CONFIGURABLE_MENU_ITEMS` in
 * `src/shared/types/menuSettings.ts`.
 *
 * A descriptor is the whole of what the rest of Apex may know about a step type without running
 * one: what it takes and returns (Zod, per TBI-032), what executing it does outside its own row and
 * what the initiator must hold to do that (TBI-033), whether it suspends and for how long.
 * Everything that reasons about steps — the publish-time gate rule, the execution-time permission
 * re-check, the agent-step cap — reads this rather than branching on a step type's name.
 *
 * Four rules are enforced at registration: BR-005's deadline (a suspension with no deadline is a
 * run that waits forever, and no reconciliation sweep can ever end it), both schemas being real Zod
 * schemas, a non-empty permission list, and a classification from the current vocabulary. The
 * registry refuses to exist rather than letting any of those through, so the failure is a boot
 * failure and not a run that dies on its third step.
 */
import { z } from 'zod';
import { PLAYBOOK_STEP_SIDE_EFFECTS } from '../../../shared/types/playbook';
import type {
  ApprovalGateStepConfig,
  BranchStepConfig,
  CursorAgentStepConfig,
  IngestArtifactStepConfig,
  NotifyStepConfig,
  PlaybookStepSideEffect,
  PlaybookStepTypeDescriptor,
  PlaybookSuspendReason,
} from '../../../shared/types/playbook';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Skills a `cursor-agent` step may run in Phase 0.
 *
 * Default-deny: a step naming anything outside this list is refused before it enqueues. This is
 * narrower than the PRD's rule, which restricts agent steps to Skills whose MCP configuration is
 * read-only. Apex has no read-only capability model to check against — `ExecutionSnapshot.skillPath`
 * is a bare path, nothing reads SKILL.md frontmatter, and the lanes that look read-only still hand
 * the agent a writable working directory — so this constrains which Skills may be named rather than
 * what they can do. The real mechanism is recorded as a gap for FEAT-008 in
 * `design-docs/playbook-epic-1-phase-0.plan.md`.
 *
 * `app-knowledge` is here because answering questions from repo documentation is its whole job.
 * FEAT-006 chooses what the seeded demo definitions actually run and may add to this list
 * deliberately; nothing is added to it by accident.
 */
export const PHASE_0_ALLOWED_AGENT_SKILLS: readonly string[] = [
  '.cursor/skills/app-knowledge/SKILL.md',
  '.cursor/skills/design-doc-validation/SKILL.md',
];

/**
 * Deadline defaults.
 *
 * `cursor-agent` is 60 minutes because that is what the existing validation watcher already allows
 * an agent turn — a 5-second poll over 720 attempts in `documentValidationService.ts` — and BR-005
 * asks for the deadline to be derived from observed behaviour rather than chosen.
 *
 * `approval-gate` is 48 hours, which has no equivalent to derive from: a human wait is not an agent
 * wait. It is overridable per definition precisely because 48 hours is a guess and some gates will
 * want hours rather than days.
 */
export const CURSOR_AGENT_DEADLINE_MS = 60 * MINUTE_MS;
export const APPROVAL_GATE_DEADLINE_MS = 48 * HOUR_MS;

/**
 * A completion time somebody can read as a time.
 *
 * Deliberately looser than a strict RFC 3339 check. What this is protecting against is a step
 * recording a completion time that is not a time at all — a run id, an empty string, a placeholder
 * — because the status view and the reconciliation sweep both treat this value as a moment. A
 * timestamp that parses but uses an unusual shape is not the failure worth refusing output over.
 */
const READABLE_TIMESTAMP = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'must be a timestamp that reads as a time');

/**
 * What each step type takes and returns, per TBI-032.
 *
 * Input schemas are the authority for a graph node's `config`; the matching interfaces in
 * `src/shared/types/playbook.ts` mirror them for callers holding a config at compile time. Output
 * schemas are parsed at the durable completion boundary, so a step cannot be recorded as complete
 * carrying something the next step's condition could not be evaluated against.
 */
const CURSOR_AGENT_INPUT_SCHEMA = z.object({
  skillPath: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().optional(),
  // Optional for immutable Phase 0 history; every newly published graph is checked separately.
  mcpProfile: z.string().min(1).optional(),
  deadlineMs: z.number().positive().max(CURSOR_AGENT_DEADLINE_MS).optional(),
  threadId: z.string().min(1).optional(),
});

const CURSOR_AGENT_OUTPUT_SCHEMA = z.object({
  agentRunId: z.string(),
  completedAt: READABLE_TIMESTAMP,
  threadId: z.string().optional(),
  scorecard: z.unknown().optional(),
  reportMd: z.string().optional(),
});

const APPROVAL_GATE_INPUT_SCHEMA = z.object({
  // `positive()` also excludes NaN and Infinity, which is the whole requirement: a deadline that
  // never arrives is the thing BR-005 exists to prevent.
  deadlineMs: z.number().positive().optional(),
  subject: z.string().optional(),
  // Optional only for Phase 1 rows. Production gates provide both values together.
  approverPool: z.enum(['prd', 'design_doc', 'design_prototype', 'test_case', 'adr']).optional(),
  gatedStepId: z.string().min(1).optional(),
});

const APPROVAL_GATE_OUTPUT_SCHEMA = z.object({
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string(),
});

const NOTIFY_INPUT_SCHEMA = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  link: z.string().optional(),
  recipientUserId: z.string().optional(),
});

const NOTIFY_OUTPUT_SCHEMA = z.object({
  notificationId: z.string(),
  // Required on the way out even though the config may omit it: by the time the step completes the
  // run initiator has been resolved, and "who was told" is the only thing this output is for.
  recipientUserId: z.string(),
});

const INGEST_ARTIFACT_INPUT_SCHEMA = z.object({
  documentType: z.enum(['design_doc', 'prd']),
  documentId: z.string().min(1),
  validationThreadId: z.string().min(1),
  scorecard: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
  reportMd: z.string().optional(),
});

const INGEST_ARTIFACT_OUTPUT_SCHEMA = z.object({
  outcome: z.enum(['applied', 'stale']),
  status: z.string().optional(),
  verdict: z.string().optional(),
  isReady: z.boolean().optional(),
});

const BRANCH_CONDITION_SCHEMA = z.object({
  sourceStepId: z.string().min(1),
  field: z.string().min(1),
  operator: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte']),
  value: z.unknown(),
});

const BRANCH_INPUT_SCHEMA = z.object({
  condition: BRANCH_CONDITION_SCHEMA,
  whenTrue: z.string().min(1),
  whenFalse: z.string().min(1),
});

const BRANCH_OUTPUT_SCHEMA = z.object({
  matched: z.boolean(),
  continuation: z.string().min(1),
});

/** The step types Apex ships. Adding a fourth is a change to this array and nowhere else. */
export const PRODUCTION_STEP_TYPES: readonly PlaybookStepTypeDescriptor[] = [
  {
    stepType: 'cursor-agent',
    canSuspend: true,
    defaultDeadlineMs: CURSOR_AGENT_DEADLINE_MS,
    // A definition may shorten the observed ceiling, but never extend it.
    deadlineOverridable: true,
    suspendReason: 'agent_run',
    allowedSkillPaths: PHASE_0_ALLOWED_AGENT_SKILLS,
    isAgentStep: true,
    // Hands work to Cursor, which Apex does not own and cannot roll back.
    sideEffect: 'leaves-apex',
    requiredPermissions: ['playbooks:run'],
    inputSchema: CURSOR_AGENT_INPUT_SCHEMA,
    outputSchema: CURSOR_AGENT_OUTPUT_SCHEMA,
  },
  {
    stepType: 'ingest-artifact',
    canSuspend: false,
    isAgentStep: false,
    sideEffect: 'writes-apex',
    requiredPermissions: ['design-docs:review', 'prds:review'],
    inputSchema: INGEST_ARTIFACT_INPUT_SCHEMA,
    outputSchema: INGEST_ARTIFACT_OUTPUT_SCHEMA,
  },
  {
    stepType: 'branch',
    canSuspend: false,
    isAgentStep: false,
    sideEffect: 'read',
    requiredPermissions: ['playbooks:view'],
    inputSchema: BRANCH_INPUT_SCHEMA,
    outputSchema: BRANCH_OUTPUT_SCHEMA,
  },
  {
    stepType: 'approval-gate',
    canSuspend: true,
    defaultDeadlineMs: APPROVAL_GATE_DEADLINE_MS,
    deadlineOverridable: true,
    suspendReason: 'approval_gate',
    isAgentStep: false,
    // Waiting changes nothing; the decision it records lives on its own step-run row.
    sideEffect: 'read',
    // Reading the run is all a gate does before someone decides, so viewing is all it needs.
    requiredPermissions: ['playbooks:view'],
    inputSchema: APPROVAL_GATE_INPUT_SCHEMA,
    outputSchema: APPROVAL_GATE_OUTPUT_SCHEMA,
  },
  {
    stepType: 'notify',
    // Completes as soon as the notification row is written, so there is nothing to wait for and
    // therefore nothing to expire.
    canSuspend: false,
    isAgentStep: false,
    sideEffect: 'writes-apex',
    requiredPermissions: ['playbooks:run'],
    inputSchema: NOTIFY_INPUT_SCHEMA,
    outputSchema: NOTIFY_OUTPUT_SCHEMA,
  },
];

export class PlaybookStepTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookStepTypeError';
  }
}

export class UnknownPlaybookStepTypeError extends PlaybookStepTypeError {
  constructor(stepType: string, known: readonly string[]) {
    super(`Unknown Playbook step type "${stepType}". Registered types: ${known.join(', ')}.`);
    this.name = 'UnknownPlaybookStepTypeError';
  }
}

/**
 * Whether a declared schema is a Zod schema, rather than something shaped like one.
 *
 * `instanceof` and not a check for a `parse` method: an object with the right method names is
 * exactly what a hand-rolled stand-in looks like, and one that validates nothing would let every
 * later parse call succeed on anything. Nothing is parsed here — a schema of entirely optional
 * fields is perfectly valid, and inventing sample data to try it against would be testing the
 * sample rather than the declaration.
 */
function assertZodSchema(stepType: string, field: string, schema: unknown): void {
  if (!(schema instanceof z.ZodType)) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" declares no usable Zod ${field}. ` +
        'Every step type states what it takes and what it returns, and an object that merely ' +
        'looks like a schema validates nothing.'
    );
  }
}

/**
 * The rules the registry exists to enforce, stated once.
 *
 * The descriptor type already makes most of these fail to compile — a suspendable type with no
 * deadline, an empty permission tuple, a classification that no longer exists. This is the runtime
 * half, and it is not redundant: a descriptor assembled from configuration, widened through a cast,
 * or arriving from a test helper never meets the compiler's version of the rule.
 */
export function validateStepTypeDescriptor(descriptor: PlaybookStepTypeDescriptor): void {
  const { stepType } = descriptor;

  if (!stepType || !stepType.trim()) {
    throw new PlaybookStepTypeError('A Playbook step type descriptor must declare a stepType.');
  }

  assertZodSchema(stepType, 'inputSchema', descriptor.inputSchema);
  assertZodSchema(stepType, 'outputSchema', descriptor.outputSchema);

  if (!PLAYBOOK_STEP_SIDE_EFFECTS.includes(descriptor.sideEffect)) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" declares the sideEffect "${descriptor.sideEffect}", which is not ` +
        `one of: ${PLAYBOOK_STEP_SIDE_EFFECTS.join(', ')}.`
    );
  }

  const permissions = descriptor.requiredPermissions;
  const declaresPermission =
    Array.isArray(permissions) &&
    permissions.length > 0 &&
    permissions.every((permission) => typeof permission === 'string' && permission.trim() !== '');

  if (!declaresPermission) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" declares no usable requiredPermissions. ` +
        'A step type that names no permission executes on whatever authority admitted the run, ' +
        'which is not the same thing as being permitted.'
    );
  }

  if (descriptor.canSuspend) {
    const deadline = descriptor.defaultDeadlineMs;
    if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) {
      throw new PlaybookStepTypeError(
        `Step type "${stepType}" can suspend but declares no usable defaultDeadlineMs. ` +
          'Every suspension needs a deadline, or the run waits forever and no sweep can end it.'
      );
    }
  } else if (descriptor.defaultDeadlineMs !== undefined) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" cannot suspend, so a defaultDeadlineMs would never be read. ` +
        'Remove it rather than leaving a value that looks meaningful.'
    );
  }
}

/**
 * Builds a registry, validating every descriptor on the way in.
 *
 * A factory rather than a mutable global with a `register()` function, so that a test can build a
 * registry from a deliberately malformed descriptor without leaving the real one damaged for every
 * test that follows.
 */
export function createStepTypeRegistry(
  descriptors: readonly PlaybookStepTypeDescriptor[]
): ReadonlyMap<string, PlaybookStepTypeDescriptor> {
  const registry = new Map<string, PlaybookStepTypeDescriptor>();

  for (const descriptor of descriptors) {
    validateStepTypeDescriptor(descriptor);
    if (registry.has(descriptor.stepType)) {
      throw new PlaybookStepTypeError(
        `Playbook step type "${descriptor.stepType}" is declared twice. ` +
          'Two descriptors for one type means the behaviour depends on array order.'
      );
    }
    registry.set(descriptor.stepType, descriptor);
  }

  return registry;
}

/**
 * Built at module load, not on first use.
 *
 * TBI-016's non-functional requirement is that a bad descriptor fails at startup. Building here
 * means importing this module is what surfaces the failure, and `src/server/index.ts` imports it
 * during boot — so the process dies before it serves a request rather than when a run first reaches
 * a step.
 */
const stepTypeRegistry = createStepTypeRegistry(PRODUCTION_STEP_TYPES);

export function listStepTypeDescriptors(): readonly PlaybookStepTypeDescriptor[] {
  return [...stepTypeRegistry.values()];
}

export function isRegisteredStepType(stepType: string): boolean {
  return stepTypeRegistry.has(stepType);
}

/** Phase 2 types, including the production form of the existing approval gate. */
export function isProductionAdapterStep(
  stepType: string,
  config: Record<string, unknown> = {},
): boolean {
  return stepType === 'ingest-artifact'
    || stepType === 'branch'
    || (stepType === 'approval-gate' && Boolean(config.approverPool));
}

export const isApprovalGateStepType = (stepType: string): boolean =>
  stepType === 'approval-gate';

export const isBranchStepType = (stepType: string): boolean =>
  stepType === 'branch';

export function requiredPermissionsForStep(
  stepType: string,
  config: Record<string, unknown>,
): readonly string[] {
  const declared = getStepTypeDescriptor(stepType).requiredPermissions;
  if (stepType !== 'ingest-artifact') return declared;
  return config.documentType === 'design_doc'
    ? ['design-docs:review']
    : ['prds:review'];
}

/** Looks up a descriptor, refusing rather than returning undefined for an unknown type. */
export function getStepTypeDescriptor(stepType: string): PlaybookStepTypeDescriptor {
  const descriptor = stepTypeRegistry.get(stepType);
  if (!descriptor) {
    throw new UnknownPlaybookStepTypeError(stepType, [...stepTypeRegistry.keys()]);
  }
  return descriptor;
}

/**
 * How long a step of this type waits, given what the definition asked for.
 *
 * An override on a type that does not permit one is refused rather than ignored: silently using a
 * different number than the definition states is how a gate that was meant to expire in an hour
 * sits open for two days.
 */
export function resolveDeadlineMs(stepType: string, overrideMs?: number): number {
  const descriptor = getStepTypeDescriptor(stepType);

  if (!descriptor.canSuspend) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" cannot suspend, so it has no deadline to resolve.`
    );
  }

  if (overrideMs === undefined) return descriptor.defaultDeadlineMs;

  if (!descriptor.deadlineOverridable) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" does not allow a per-definition deadline; its default is derived ` +
        'from what the platform tolerates, not chosen.'
    );
  }

  if (!Number.isFinite(overrideMs) || overrideMs <= 0) {
    throw new PlaybookStepTypeError(
      `Deadline override for step type "${stepType}" must be a positive number of milliseconds.`
    );
  }

  if (stepType === 'cursor-agent' && overrideMs > descriptor.defaultDeadlineMs) {
    throw new PlaybookStepTypeError(
      `Deadline override for step type "${stepType}" may shorten the derived default but not exceed it.`
    );
  }

  return overrideMs;
}

/**
 * What a parked step of this type is waiting on.
 *
 * Deliberately tolerant of an unknown step type, unlike every other lookup here. This is read by
 * the status projection against historical rows, and a run recorded before a step type was renamed
 * or removed must still render rather than throwing. An unregistered type reads as `agent_run`
 * because no current adapter could have produced it, so it is not a gate anyone can go and approve.
 */
export function suspendReasonForStepType(stepType: string): PlaybookSuspendReason {
  const descriptor = stepTypeRegistry.get(stepType);
  return descriptor?.canSuspend ? descriptor.suspendReason : 'agent_run';
}

/**
 * Whether this type counts against the agent-step cap.
 *
 * Tolerant of an unknown type for the same reason `suspendReasonForStepType` is: the guard runs
 * over stored definition graphs, and one naming a type that no longer exists should be refused by
 * the step-type check rather than crash the counter on its way there.
 */
export function isAgentStepType(stepType: string): boolean {
  return stepTypeRegistry.get(stepType)?.isAgentStep ?? false;
}

/**
 * What executing a step of this type does outside its own row.
 *
 * Undefined for a type nobody recognises, rather than any of the three classifications. A type the
 * registry cannot name has not been shown to be harmless, and a caller that wants to treat it as
 * such should have to say so.
 */
export function sideEffectOfStepType(stepType: string): PlaybookStepSideEffect | undefined {
  return stepTypeRegistry.get(stepType)?.sideEffect;
}

/**
 * Whether the execution-time permission re-check applies to this step type.
 *
 * A `read` step is left alone: re-checking it would cost a query per step to re-derive an answer
 * nothing acts on. Anything else is re-checked, and so is an unknown type — an unrecognised step
 * type is the one case where skipping the check cannot be justified, even though `executeStep`
 * refuses an unregistered type before this is ever consulted.
 */
export function requiresInitiatorPermissionRecheck(stepType: string): boolean {
  return sideEffectOfStepType(stepType) !== 'read';
}

/**
 * Refuses a Skill this step type may not run. Called before anything is enqueued, per TBI-017 —
 * validating after the agent run exists would mean the refusal has already cost a run.
 */
export function assertSkillAllowed(stepType: string, skillPath: string): void {
  const allowed = getStepTypeDescriptor(stepType).allowedSkillPaths ?? [];

  if (!allowed.includes(skillPath)) {
    throw new PlaybookStepTypeError(
      `Step type "${stepType}" may not run Skill "${skillPath}". ` +
        `Phase 0 permits: ${allowed.join(', ') || 'no Skills'}.`
    );
  }
}

/**
 * Called from `src/server/index.ts` during boot.
 *
 * The module-level build above already rejects a malformed descriptor, but it does so as an import
 * error, which surfaces as whichever module happened to pull this one in first. This gives the
 * failure a name and a place, and additionally asserts the things a per-descriptor check cannot
 * see: that the three types the product actually ships are present, and that a type permitted to
 * run Skills actually names some. An empty allow-list would be a step type that can never execute.
 *
 * The named three are a boot assertion, not a constraint on the registry — `createStepTypeRegistry`
 * stays generic so a fourth type can be registered by a caller without editing anything here.
 */
export function validateStepTypeRegistry(): void {
  const expected = ['cursor-agent', 'approval-gate', 'notify', 'ingest-artifact', 'branch'];
  const missing = expected.filter((stepType) => !stepTypeRegistry.has(stepType));

  if (missing.length > 0) {
    throw new PlaybookStepTypeError(
      `Playbook step type registry is missing: ${missing.join(', ')}. ` +
        'Apex ships all three.'
    );
  }

  for (const descriptor of stepTypeRegistry.values()) {
    if (descriptor.allowedSkillPaths && descriptor.allowedSkillPaths.length === 0) {
      throw new PlaybookStepTypeError(
        `Step type "${descriptor.stepType}" declares an empty Skill allow-list, so every step of ` +
          'that type would be refused. Remove the list or name a Skill.'
      );
    }
  }
}

/** Config shapes, re-exported so adapters import their contract from the registry they register with. */
export type {
  ApprovalGateStepConfig,
  BranchStepConfig,
  CursorAgentStepConfig,
  IngestArtifactStepConfig,
  NotifyStepConfig,
  PlaybookStepTypeDescriptor,
};
