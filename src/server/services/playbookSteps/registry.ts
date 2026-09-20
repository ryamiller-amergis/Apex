/**
 * The only place a Playbook step type is declared.
 *
 * TBI-016 asks for the smallest registry that works, and the smallest thing that works is a map
 * built from three literals at module load. There is no discovery, no plugin scan and no dynamic
 * registration: a closed set validated up front, in the spirit of `CONFIGURABLE_MENU_ITEMS` in
 * `src/shared/types/menuSettings.ts`.
 *
 * Phase 0 deliberately omits Zod input/output schemas, `sideEffect` classification and
 * `requiredPermissions`. Those are FEAT-008's contract, and designing them now would mean fixing
 * the shape of a contract before three adapters have shown what it needs to carry.
 *
 * The one rule enforced here is BR-005: a step type that can suspend must declare a deadline. A
 * suspension with no deadline is a run that waits forever, and no reconciliation sweep can ever end
 * it — so the registry refuses to exist rather than letting one be registered.
 */
import type {
  ApprovalGateStepConfig,
  CursorAgentStepConfig,
  NotifyStepConfig,
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

/** The three step types Phase 0 ships. Adding a fourth is a change to this array and nowhere else. */
export const PHASE_0_STEP_TYPES: readonly PlaybookStepTypeDescriptor[] = [
  {
    stepType: 'cursor-agent',
    canSuspend: true,
    defaultDeadlineMs: CURSOR_AGENT_DEADLINE_MS,
    // Not overridable: the 60 minutes is derived from what the platform actually tolerates, so a
    // definition choosing its own number would be overriding an observation with a preference.
    deadlineOverridable: false,
    suspendReason: 'agent_run',
    allowedSkillPaths: PHASE_0_ALLOWED_AGENT_SKILLS,
  },
  {
    stepType: 'approval-gate',
    canSuspend: true,
    defaultDeadlineMs: APPROVAL_GATE_DEADLINE_MS,
    deadlineOverridable: true,
    suspendReason: 'approval_gate',
  },
  {
    stepType: 'notify',
    // Completes as soon as the notification row is written, so there is nothing to wait for and
    // therefore nothing to expire.
    canSuspend: false,
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
 * The rule the registry exists to enforce, stated once.
 *
 * The descriptor type already makes a suspendable-without-deadline literal fail to compile. This is
 * the runtime half, and it is not redundant: a descriptor assembled from configuration, widened
 * through a cast, or arriving from a test helper never meets the compiler's version of the rule.
 */
export function validateStepTypeDescriptor(descriptor: PlaybookStepTypeDescriptor): void {
  const { stepType } = descriptor;

  if (!stepType || !stepType.trim()) {
    throw new PlaybookStepTypeError('A Playbook step type descriptor must declare a stepType.');
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
const stepTypeRegistry = createStepTypeRegistry(PHASE_0_STEP_TYPES);

export function listStepTypeDescriptors(): readonly PlaybookStepTypeDescriptor[] {
  return [...stepTypeRegistry.values()];
}

export function isRegisteredStepType(stepType: string): boolean {
  return stepTypeRegistry.has(stepType);
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
 * see: that all three Phase 0 types are present, and that a type permitted to run Skills actually
 * names some. An empty allow-list would be a step type that can never execute.
 */
export function validateStepTypeRegistry(): void {
  const expected = ['cursor-agent', 'approval-gate', 'notify'];
  const missing = expected.filter((stepType) => !stepTypeRegistry.has(stepType));

  if (missing.length > 0) {
    throw new PlaybookStepTypeError(
      `Playbook step type registry is missing: ${missing.join(', ')}. ` +
        'Phase 0 requires all three.'
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
  CursorAgentStepConfig,
  NotifyStepConfig,
  PlaybookStepTypeDescriptor,
};
