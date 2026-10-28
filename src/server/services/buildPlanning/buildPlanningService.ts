/**
 * Starts the planner, records its plan file, and runs the repair loop.
 * Callers in later features import these functions. This feature does not
 * wire them into the Playbook step or the completion handler.
 */
import { randomUUID } from 'crypto';
import type { BuildPlan, PlanValidationResult, PlanViolation } from '../../../shared/buildPlanSchema';
import { BUILD_RUN_STATUSES, integrationBranchName, type BuildSuspendReason } from '../../../shared/types/build';
import { BuildLaunchRefusedError } from './launchGuard';
import {
  contactNames,
  expectedClassification,
  focusedError,
  plannerGuard,
  plannerInFlight,
  plannerRoleReady,
  toStoredTasks,
  validationRecord,
  type AgentRunOutcome,
  type PlannerLaunchRequest,
  type PlannerLaunchResult,
  type PlanningCompletionResult,
  type PlanningEvent,
  type PlanningStartResult,
  type PlanningStore,
  type PlanningView,
  type PlanningWrite,
} from './planningModel';
import { validateBuildPlan } from './planValidator';
import { buildPlannerPrompt } from './plannerPrompt';
import { parsePlanFile, PLANNER_STOPPED_MESSAGE, redactPlanStrings } from './plannerResult';

const REPAIR_CAP = 2;
const RESUME_REASONS: readonly BuildSuspendReason[] = ['flag_disabled', 'permission_revoked', 'configuration'];

export interface BuildPlanningDeps {
  store: PlanningStore;
  assertLaunch: (input: { buildRunId: string }) => Promise<void>;
  launch: (request: PlannerLaunchRequest) => Promise<PlannerLaunchResult>;
  /**
   * `branch` is the branch the agent reported; null means the integration branch.
   * Returns null when the file does not exist. Throws when the read itself fails.
   */
  readPlanFile: (view: PlanningView, branch: string | null) => Promise<string | null>;
  /**
   * Ends a planner agent run that Apex no longer waits on, so the next attempt
   * can hold the one live agent run allowed per build task. Must do nothing
   * when the run has already ended.
   */
  releaseAgentRun: (agentRunId: string, outcome: AgentRunOutcome) => Promise<void>;
  catalogExcerpt?: (view: PlanningView) => Promise<string>;
  now?: () => number;
  track?: (name: string, properties: Record<string, string>) => void;
}

/** Thrown when the plan file read fails for a reason other than "not found". */
export class PlanFileReadError extends Error {
  constructor(readonly cause?: unknown) {
    super('The plan file could not be read.');
    this.name = 'PlanFileReadError';
  }
}

export async function startPlanning(
  input: { buildRunId: string; revisionNumber: number },
  deps: BuildPlanningDeps,
): Promise<PlanningStartResult> {
  const view = await deps.store.load(input.buildRunId, input.revisionNumber);
  if (!view) return { status: 'refused', reason: 'configuration' };
  if (view.planValidation?.status === 'pass') return { status: 'already_planned' };
  if (view.classification === 'small') {
    if (view.status === 'building') return { status: 'small_path' };
    if (view.status !== 'intake' && view.status !== 'planning') return notPlanning(view);
    return recordSmallPath(view, deps);
  }
  if (view.status !== 'intake' && view.status !== 'planning') return notPlanning(view);
  return launchFullPlanner(view, deps, 'start');
}

export async function resumePlanning(
  input: { buildRunId: string },
  deps: BuildPlanningDeps,
): Promise<PlanningStartResult> {
  const loaded = await deps.store.load(input.buildRunId);
  if (!loaded) return { status: 'refused', reason: 'configuration' };
  if (loaded.planValidation?.status === 'pass') return { status: 'already_planned' };

  const view = loaded;
  if (view.status === 'suspended') {
    const reason = view.suspendReason;
    if (!reason || !RESUME_REASONS.includes(reason) || view.suspendedFromStatus !== 'planning') {
      return notPlanning(view);
    }
  } else if (view.status !== 'planning') {
    return notPlanning(view);
  }

  const keepLaunch = view.planner?.status === 'ready' && plannerInFlight(view.planner, nowOf(deps));
  const reset = await deps.store.applyIf(view.buildRunId, {
    runStatuses: [view.status],
    planner: plannerGuard(view.planner),
  }, {
    runStatus: 'planning',
    suspendReason: null,
    suspendedFromStatus: null,
    ...(view.planner && !keepLaunch ? { planner: { ...view.planner, status: 'failed' as const } } : {}),
  });
  if (!reset) return currentStartResult(view.buildRunId, deps);
  if (reset.classification === 'small') return recordSmallPath(reset, deps);
  return launchFullPlanner(reset, deps, 'resume');
}

function notPlanning(view: PlanningView): PlanningStartResult {
  return { status: 'not_planning', runStatus: view.status, suspendReason: view.suspendReason };
}

/** Reports where a run stands after another caller changed it first. */
async function currentStartResult(buildRunId: string, deps: BuildPlanningDeps): Promise<PlanningStartResult> {
  const current = await deps.store.load(buildRunId);
  if (!current) return { status: 'refused', reason: 'configuration' };
  if (current.planValidation?.status === 'pass') return { status: 'already_planned' };
  if (current.status === 'building' && current.classification === 'small') return { status: 'small_path' };
  if (current.status === 'planning' && current.planner && plannerInFlight(current.planner, nowOf(deps))) {
    return { status: 'launched', attempt: current.planner.attempt };
  }
  return notPlanning(current);
}

function nowOf(deps: BuildPlanningDeps): number {
  return (deps.now ?? Date.now)();
}

export async function applyPlannerCompletion(
  input: {
    buildRunId: string;
    agentRunId: string;
    agentStatus: 'finished' | 'error' | 'cancelled';
    branchName?: string | null;
  },
  deps: BuildPlanningDeps,
): Promise<PlanningCompletionResult> {
  const view = await deps.store.load(input.buildRunId);
  if (!view?.planner) return { status: 'ignored' };
  if (view.status !== 'planning') {
    await deps.store.apply(view.buildRunId, {
      events: [ignoredEvent(view, 'run_not_planning')],
    });
    return { status: 'ignored' };
  }
  if (view.planner.agentRunId !== input.agentRunId || view.planner.status !== 'running') {
    return { status: 'ignored' };
  }
  if (input.agentStatus === 'cancelled') {
    const claimed = await deps.store.claimAndApply(view.buildRunId, input.agentRunId, {
      planner: { ...view.planner, status: 'failed' },
      events: [ignoredEvent(view, 'agent_cancelled')],
    });
    if (claimed) await deps.releaseAgentRun(input.agentRunId, 'cancelled');
    return { status: 'ignored' };
  }

  let parsed: Awaited<ReturnType<typeof readValidatedPlan>>;
  try {
    parsed = await readValidatedPlan(view, input.branchName ?? null, deps);
  } catch (error) {
    if (error instanceof PlanFileReadError) return { status: 'deferred' };
    throw error;
  }
  if (parsed.ok) {
    const plan = parsed.plan as BuildPlan;
    const durationMs = elapsed(view, deps);
    const claimed = await deps.store.claimAndApply(view.buildRunId, input.agentRunId, {
      runStatus: 'building',
      plan: parsed.plan,
      planValidation: { status: 'pass', violations: [] },
      contextNotesPath: plan.contextNotesPath,
      planner: { ...view.planner, status: 'merged' },
      tasks: toStoredTasks(plan),
      events: [
        ...(parsed.redactionCount > 0 ? [redactedEvent(view, parsed.redactionCount)] : []),
        {
          eventType: 'plan.validated',
          message: 'The technical plan passed validation.',
          detail: {
            taskCount: plan.tasks.length,
            classification: plan.classification,
            repairAttempts: view.repairAttempts,
            durationMs,
          },
          dedupeKey: `${view.revisionId}:plan.validated:${view.planner.attempt}`,
        },
      ],
    });
    if (!claimed) return { status: 'ignored' };
    await deps.releaseAgentRun(input.agentRunId, input.agentStatus === 'error' ? 'failed' : 'completed');
    deps.track?.('build.plan.validated', {
      taskCount: String(plan.tasks.length),
      classification: plan.classification,
      repairAttempts: String(view.repairAttempts),
      durationMs: String(durationMs),
    });
    return { status: 'validated' };
  }

  const nextRepair = view.repairAttempts + 1;
  const suspend = nextRepair >= REPAIR_CAP;
  const error = focusedError(parsed.violations, contactNames(view));
  const claimed = await deps.store.claimAndApply(view.buildRunId, input.agentRunId, {
    incrementRepair: view.repairAttempts < REPAIR_CAP,
    planner: { ...view.planner, status: 'failed' },
    events: [
      ...(parsed.redactionCount > 0 ? [redactedEvent(view, parsed.redactionCount)] : []),
      suspend
        ? {
            eventType: 'plan.invalid',
            severity: 'error' as const,
            message: error.message,
            detail: {
              codes: parsed.violations.map((row) => row.code),
              focusedError: error.message,
            },
            dedupeKey: `${view.revisionId}:plan.invalid`,
          }
        : {
            eventType: 'plan.repair_requested',
            message: `Planning — fixing the plan (repair ${nextRepair} of 2)`,
            detail: {
              codes: parsed.violations.map((row) => row.code),
              taskKeys: parsed.violations.flatMap((row) => row.taskKeys ?? []),
            },
            dedupeKey: `${view.revisionId}:plan.repair_requested:${nextRepair}`,
          },
    ],
    ...(suspend
      ? {
          runStatus: 'suspended' as const,
          suspendReason: 'plan_invalid' as const,
          suspendedFromStatus: 'planning' as const,
          planValidation: { status: 'fail' as const, violations: parsed.violations },
        }
      : {
          planValidation: { status: 'fail' as const, violations: parsed.violations },
        }),
  });
  if (!claimed) return { status: 'ignored' };
  await deps.releaseAgentRun(input.agentRunId, input.agentStatus === 'error' ? 'failed' : 'completed');
  if (suspend) return { status: 'suspended', reason: 'plan_invalid' };

  const refreshed = await deps.store.load(view.buildRunId);
  if (!refreshed) return { status: 'ignored' };
  const launched = await launchFullPlanner(refreshed, deps, 'repair');
  if (launched.status === 'refused') {
    return { status: 'suspended', reason: launched.reason };
  }
  return { status: 'repair_requested', attempt: launched.status === 'launched' ? launched.attempt : nextRepair };
}

export async function validateAndRecordPlan(
  input: {
    buildRunId: string;
    revisionNumber: number;
    rawPlan: unknown;
    source: 'planner' | 'small_agent' | 'escalation';
  },
  deps: BuildPlanningDeps,
): Promise<PlanValidationResult> {
  const view = await deps.store.load(input.buildRunId, input.revisionNumber);
  if (!view) return { ok: false, violations: [{ code: 'invalid_value', message: PLANNER_STOPPED_MESSAGE }] };
  const redacted = redactPlanStrings(input.rawPlan);
  const result = validateBuildPlan({
    plan: redacted.plan,
    requirements: view.requirements,
    riskDecisions: view.riskDecisions,
    classification: expectedClassification(view.classification, input.source),
  });
  const storedPlan = redacted.plan as Partial<BuildPlan>;
  const events: PlanningEvent[] = [];
  if (redacted.redactionCount > 0) events.push(redactedEvent(view, redacted.redactionCount));
  if (input.source !== 'planner') {
    events.push({
      eventType: 'plan.recorded_small',
      message: result.ok ? 'The short plan was recorded.' : 'The short plan was recorded and did not pass validation.',
      detail: { ok: result.ok, source: input.source },
      dedupeKey: `${view.revisionId}:plan.recorded_small:${input.source}`,
    });
  }
  await deps.store.apply(view.buildRunId, {
    plan: redacted.plan,
    contextNotesPath: typeof storedPlan.contextNotesPath === 'string' ? storedPlan.contextNotesPath : view.contextNotesPath,
    planValidation: validationRecord(result),
    events,
  });
  return result;
}

async function recordSmallPath(view: PlanningView, deps: BuildPlanningDeps): Promise<PlanningStartResult> {
  if (view.status === 'intake' || view.status === 'planning') {
    const moved = await deps.store.applyIf(view.buildRunId, { runStatuses: ['intake', 'planning'] }, {
      runStatus: 'building',
      events: [{
        eventType: 'plan.started',
        message: 'A small build skips the planner and starts on the integration branch.',
        detail: { path: 'small' },
        dedupeKey: `${view.revisionId}:plan.started:small`,
      }],
    });
    if (!moved) return currentStartResult(view.buildRunId, deps);
  }
  return { status: 'small_path' };
}

async function launchFullPlanner(
  view: PlanningView,
  deps: BuildPlanningDeps,
  reason: 'start' | 'repair' | 'resume',
): Promise<PlanningStartResult> {
  try {
    await deps.assertLaunch({ buildRunId: view.buildRunId });
  } catch (error) {
    if (error instanceof BuildLaunchRefusedError) {
      await suspend(view, error.reason, deps);
      return { status: 'refused', reason: error.reason };
    }
    throw error;
  }
  if (!plannerRoleReady(view.skillSnapshot)) {
    await suspend(view, 'configuration', deps);
    return { status: 'refused', reason: 'configuration' };
  }
  const nowMs = nowOf(deps);
  if (view.planner && plannerInFlight(view.planner, nowMs)) {
    return { status: 'launched', attempt: view.planner.attempt };
  }

  const retrying = view.planner?.status === 'failed' || view.planner?.status === 'ready';
  const attempt = view.planner && retrying ? view.planner.attempt + 1 : 1;
  const planner = {
    id: view.planner?.id ?? randomUUID(),
    status: 'ready' as const,
    attempt,
    agentRunId: null,
    startedAtMs: nowMs,
  };
  const branch = view.integrationBranch ?? integrationBranchName(view.buildRunId);
  const prepared = await deps.store.applyIf(view.buildRunId, {
    runStatuses: ['intake', 'planning'],
    planner: plannerGuard(view.planner),
  }, {
    runStatus: 'planning',
    suspendReason: null,
    suspendedFromStatus: null,
    planner,
    ...(reason === 'repair' ? {} : {
      events: [{
        eventType: 'plan.started',
        message: 'Planning — writing the technical plan',
        detail: { path: 'full', attempt },
        dedupeKey: `${view.revisionId}:plan.started:${attempt}`,
      }],
    }),
  });
  if (!prepared) return currentStartResult(view.buildRunId, deps);
  if (view.planner?.agentRunId) {
    await deps.releaseAgentRun(view.planner.agentRunId, 'cancelled');
  }
  const ours = { status: 'ready' as const, attempt };

  const mode = reason === 'repair' || prepared.repairAttempts > 0 ? 'repair' : 'full';
  const violations = prepared.planValidation?.status === 'fail' ? prepared.planValidation.violations : [];
  const prompt = buildPlannerPrompt({
    mode,
    buildRunId: prepared.buildRunId,
    integrationBranch: branch,
    brief: prepared.briefText,
    requirements: prepared.requirements,
    riskDecisions: prepared.riskDecisions,
    standards: standardsOf(prepared),
    catalogExcerpt: await (deps.catalogExcerpt ?? (async () => ''))(prepared),
    violations,
  });
  let launched: PlannerLaunchResult;
  try {
    launched = await deps.launch({
      buildRunId: prepared.buildRunId,
      project: prepared.project,
      repository: prepared.repository,
      prompt,
      model: prepared.skillSnapshot.planner.model,
      skillPath: prepared.skillSnapshot.planner.skillPath,
      skillHash: prepared.skillSnapshot.planner.contentHash,
      startingRef: attempt === 1 ? (prepared.baseCommit ?? branch) : branch,
      integrationBranch: branch,
      plannerTaskId: planner.id,
      attempt,
    });
  } catch (error) {
    await deps.store.applyIf(prepared.buildRunId, { runStatuses: BUILD_RUN_STATUSES, planner: ours }, {
      planner: { ...planner, status: 'failed' },
    });
    throw error;
  }
  const running = await deps.store.applyIf(prepared.buildRunId, { runStatuses: ['planning'], planner: ours }, {
    planner: {
      ...planner,
      status: 'running',
      agentRunId: launched.agentRunId,
      startedAtMs: nowOf(deps),
    },
  });
  if (!running) {
    // The run was cancelled or suspended, or the slot was reset, while the agent launched.
    await deps.releaseAgentRun(launched.agentRunId, 'cancelled');
    await deps.store.applyIf(prepared.buildRunId, { runStatuses: BUILD_RUN_STATUSES, planner: ours }, {
      planner: { ...planner, status: 'failed' },
    });
    return currentStartResult(prepared.buildRunId, deps);
  }
  return { status: 'launched', attempt };
}

async function readValidatedPlan(
  view: PlanningView,
  branch: string | null,
  deps: BuildPlanningDeps,
): Promise<{ ok: true; plan: unknown; redactionCount: number } | { ok: false; violations: PlanViolation[]; redactionCount: number }> {
  let text: string | null;
  try {
    text = await deps.readPlanFile(view, branch);
  } catch (error) {
    throw new PlanFileReadError(error);
  }
  const parsed = parsePlanFile(text);
  if (!parsed.ok) return { ok: false, violations: [parsed.violation], redactionCount: 0 };
  const result = validateBuildPlan({
    plan: parsed.redacted.plan,
    requirements: view.requirements,
    riskDecisions: view.riskDecisions,
    classification: expectedClassification(view.classification, 'planner'),
  });
  if (!result.ok) {
    return { ok: false, violations: result.violations, redactionCount: parsed.redacted.redactionCount };
  }
  return { ok: true, plan: parsed.redacted.plan, redactionCount: parsed.redacted.redactionCount };
}

async function suspend(
  view: PlanningView,
  reason: 'flag_disabled' | 'permission_revoked' | 'configuration',
  deps: BuildPlanningDeps,
): Promise<void> {
  const from = view.status === 'planning' || view.status === 'intake' ? view.status : 'planning';
  await deps.store.applyIf(view.buildRunId, { runStatuses: ['intake', 'planning'] }, {
    runStatus: 'suspended',
    suspendReason: reason,
    suspendedFromStatus: from,
  });
}

function elapsed(view: PlanningView, deps: BuildPlanningDeps): number {
  const started = view.planner?.startedAtMs;
  if (started == null) return 0;
  return Math.max(0, (deps.now ?? Date.now)() - started);
}

function ignoredEvent(view: PlanningView, reason: string): PlanningEvent {
  return {
    eventType: 'plan.ignored',
    message: 'The planner result was ignored.',
    detail: { reason },
    dedupeKey: `${view.revisionId}:plan.ignored:${view.planner?.agentRunId ?? reason}`,
  };
}

function redactedEvent(view: PlanningView, count: number): PlanningEvent {
  return {
    eventType: 'plan.redacted',
    message: 'Secret-shaped text was removed from the plan before it was stored.',
    detail: { count },
    dedupeKey: `${view.revisionId}:plan.redacted:${view.planner?.attempt ?? 0}:${count}`,
  };
}

function standardsOf(view: PlanningView) {
  const rules = view.skillSnapshot.codingRules;
  return {
    designSystemPath: view.skillSnapshot.designSystemFile.path,
    designSystemHash: view.skillSnapshot.designSystemFile.hash,
    codingRulesPath: rules.path,
    codingRulesHash: rules.hash,
    codeMapPath: view.skillSnapshot.codeMap.path,
    codeMapHash: view.skillSnapshot.codeMap.hash,
  };
}

export type { PlanningWrite };
