/**
 * PBI-014 / PBI-015 / TBI-013 — planning service with a fake planner.
 * VT-18 through VT-27 and VT-29. No live Cloud Agent.
 */
import {
  applyPlannerCompletion,
  resumePlanning,
  startPlanning,
  validateAndRecordPlan,
  type BuildPlanningDeps,
} from '../services/buildPlanning/buildPlanningService';
import { BuildLaunchRefusedError } from '../services/buildPlanning/launchGuard';
import { guardMatches, PLANNER_READY_STALE_MS, toStoredTasks } from '../services/buildPlanning/planningModel';
import type { BuildPlan } from '../../shared/buildPlanSchema';
import type {
  AgentRunOutcome,
  PlannerLaunchRequest,
  PlanningEvent,
  PlanningGuard,
  PlanningStore,
  PlanningView,
  PlanningWrite,
} from '../services/buildPlanning/planningModel';
import { validFullPlan, validJustifiedPlan } from '../../shared/fixtures/buildPlanFixtures';
import { planInvalidNotice, planningHeaderText } from '../../shared/buildPlanCopy';
import type { BuildClassification, BuildRequirement, BuildRiskDecision, BuildSkillSnapshot } from '../../shared/types/build';

function requirement(id: string): BuildRequirement {
  const kind = id.startsWith('DOD') ? 'dod' : id.startsWith('BR') ? 'br' : id.startsWith('NFR') ? 'nfr' : 'ac';
  return { id, kind, text: id, retired: false };
}

function risk(id: string): BuildRiskDecision {
  return { id, category: 'data', rating: 'low', decision: 'keep', rationale: 'audit' };
}

function role(model = 'composer-2') {
  return { model, skillPath: '.cursor/skills/build-planner/SKILL.md', contentHash: 'd'.repeat(64) };
}

function snapshot(model = 'composer-2'): BuildSkillSnapshot {
  return {
    intake: role(model),
    planner: role(model),
    implementer: role(model),
    qa: role(model),
    check: role(model),
    designSystemFile: { path: 'docs/design-system.md', hash: 'a'.repeat(64) },
    codingRules: { path: '.cursor/rules/react-coding-standards.mdc', hash: 'b'.repeat(64) },
    codeMap: { path: '.cursor/CODEMAP.md', hash: 'c'.repeat(64) },
  };
}

function view(overrides: Partial<PlanningView> = {}): PlanningView {
  return {
    buildRunId: 'run-1',
    project: 'Apex',
    repository: 'Apex',
    requestedByUserId: 'user-1',
    status: 'intake',
    suspendReason: null,
    suspendedFromStatus: null,
    integrationBranch: 'apex/build/run-1',
    baseCommit: 'a'.repeat(40),
    skillSnapshot: snapshot(),
    supportContacts: [
      { userId: 's1', displayName: 'Ada', email: 'ada@example.com' },
      { userId: 's2', displayName: 'Bo', email: 'bo@example.com' },
    ],
    revisionId: 'rev-1',
    revisionNumber: 1,
    classification: 'full',
    requirements: [requirement('AC-1'), requirement('AC-2'), requirement('DOD-1'), requirement('DOD-2')],
    riskDecisions: [risk('RD-1')],
    plan: null,
    planValidation: null,
    repairAttempts: 0,
    contextNotesPath: null,
    briefText: 'Ship the widget.',
    planner: null,
    planTasks: [],
    implementerCount: 0,
    ...overrides,
  };
}

class MemoryStore implements PlanningStore {
  events: PlanningEvent[] = [];
  launches = 0;

  constructor(public current: PlanningView) {}

  async load(): Promise<PlanningView | null> {
    return structuredClone(this.current);
  }

  async apply(_buildRunId: string, write: PlanningWrite): Promise<PlanningView> {
    this.applyWrite(write);
    return structuredClone(this.current);
  }

  async applyIf(_buildRunId: string, guard: PlanningGuard, write: PlanningWrite): Promise<PlanningView | null> {
    if (!guardMatches(this.current, guard)) return null;
    this.applyWrite(write);
    return structuredClone(this.current);
  }

  async claimAndApply(_buildRunId: string, agentRunId: string, write: PlanningWrite): Promise<PlanningView | null> {
    const planner = this.current.planner;
    if (this.current.status !== 'planning') return null;
    if (!planner || planner.status !== 'running' || planner.agentRunId !== agentRunId) return null;
    this.applyWrite(write);
    return structuredClone(this.current);
  }

  private applyWrite(write: PlanningWrite): void {
    const row = this.current;
    if (write.incrementRepair && row.repairAttempts < 2) row.repairAttempts += 1;
    if (write.plan !== undefined) row.plan = write.plan;
    if (write.planValidation) row.planValidation = write.planValidation;
    if (write.contextNotesPath !== undefined) row.contextNotesPath = write.contextNotesPath;
    if (write.runStatus) {
      row.status = write.runStatus;
      if (write.runStatus === 'suspended') {
        row.suspendReason = write.suspendReason ?? row.suspendReason;
        row.suspendedFromStatus = write.suspendedFromStatus ?? row.suspendedFromStatus;
      } else {
        row.suspendReason = null;
        row.suspendedFromStatus = null;
      }
    }
    if (write.planner) row.planner = { ...write.planner };
    if (write.tasks) {
      row.planTasks = write.tasks;
      row.implementerCount = write.tasks.filter((task) => task.role === 'implementer').length;
    }
    this.events.push(...(write.events ?? []));
  }
}

function harness(store: MemoryStore, options?: {
  files?: Array<string | null>;
  refuseOnLaunch?: number;
  now?: () => number;
}) {
  const files = [...(options?.files ?? [JSON.stringify(validFullPlan)])];
  const requests: PlannerLaunchRequest[] = [];
  const releases: Array<[string, AgentRunOutcome]> = [];
  let guardCalls = 0;
  const deps: BuildPlanningDeps & { track: jest.Mock } = {
    store,
    now: options?.now ?? (() => 5_000),
    track: jest.fn(),
    releaseAgentRun: async (agentRunId, outcome) => {
      if (releases.some(([id]) => id === agentRunId)) return;
      releases.push([agentRunId, outcome]);
    },
    catalogExcerpt: async () => 'Button',
    assertLaunch: async () => {
      guardCalls += 1;
      if (options?.refuseOnLaunch != null && guardCalls >= options.refuseOnLaunch) {
        throw new BuildLaunchRefusedError('flag_disabled');
      }
    },
    readPlanFile: async () => (files.length > 0 ? files.shift() ?? null : null),
    launch: async (request: PlannerLaunchRequest) => {
      expect(store.current.planner?.status).toBe('ready');
      expect(request.model).toBeTruthy();
      expect(request.skillPath).toContain('build-planner');
      expect(request.skillHash).toHaveLength(64);
      expect(request.integrationBranch).toBe('apex/build/run-1');
      expect(JSON.stringify(request)).not.toContain('Bearer');
      requests.push(request);
      return { agentRunId: `agent-${requests.length}` };
    },
  };
  return { deps, requests, releases, guardCalls: () => guardCalls };
}

async function finish(store: MemoryStore, deps: BuildPlanningDeps, status: 'finished' | 'error' | 'cancelled' = 'finished') {
  const agentRunId = store.current.planner?.agentRunId;
  if (!agentRunId) throw new Error('planner has no agent run');
  return applyPlannerCompletion({
    buildRunId: store.current.buildRunId,
    agentRunId,
    agentStatus: status,
  }, deps);
}

describe('build planning service', () => {
  it('VT-18 / PBI-014 (a) stores a passing plan and moves the run to building in one write', async () => {
    const store = new MemoryStore(view());
    const { deps } = harness(store, { now: () => 20_000 });
    store.current.planner = null;
    const started = await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(started).toEqual({ status: 'launched', attempt: 1 });
    expect(store.current.status).toBe('planning');
    expect(store.current.planValidation).toBeNull();
    expect(store.current.implementerCount).toBe(0);
    store.current.planner = { ...store.current.planner!, startedAtMs: 5_000 };
    const result = await finish(store, deps);
    expect(result).toEqual({ status: 'validated' });
    expect(store.current.status).toBe('building');
    expect(store.current.planValidation?.status).toBe('pass');
    expect(store.current.plan).toEqual(validFullPlan);
    expect(store.current.contextNotesPath).toBe(validFullPlan.contextNotesPath);
    expect(store.current.implementerCount).toBeGreaterThan(0);
    expect(store.events.some((event) => event.eventType === 'plan.validated')).toBe(true);
    const validated = store.events.find((event) => event.eventType === 'plan.validated');
    expect(validated?.detail).toMatchObject({ durationMs: 15_000, classification: 'full' });
  });

  it('VT-18 reads the plan file from the branch the agent reported', async () => {
    const store = new MemoryStore(view());
    const { deps } = harness(store);
    const branches: Array<string | null> = [];
    deps.readPlanFile = async (_view, branch) => {
      branches.push(branch);
      return JSON.stringify(validFullPlan);
    };
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const result = await applyPlannerCompletion({
      buildRunId: 'run-1',
      agentRunId: store.current.planner!.agentRunId!,
      agentStatus: 'finished',
      branchName: 'cursor/plan-abc',
    }, deps);
    expect(result).toEqual({ status: 'validated' });
    expect(branches).toEqual(['cursor/plan-abc']);
  });

  it('VT-19 / PBI-014 (b) counts one repair and then accepts the corrected plan', async () => {
    const broken = { ...validFullPlan, tasks: validFullPlan.tasks.map((task) => ({ ...task, ownedFiles: ['src/shared.ts'] })) };
    const store = new MemoryStore(view());
    const { deps, releases } = harness(store, { files: [JSON.stringify(broken), JSON.stringify(validFullPlan)] });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const first = await finish(store, deps);
    expect(first.status).toBe('repair_requested');
    expect(releases).toEqual([['agent-1', 'completed']]);
    expect(store.current.repairAttempts).toBe(1);
    expect(store.current.status).toBe('planning');
    expect(store.events.some((event) => event.eventType === 'plan.repair_requested')).toBe(true);
    expect(planningHeaderText(1)).toBe('Planning — fixing the plan (repair 1 of 2)');
    const second = await finish(store, deps);
    expect(second).toEqual({ status: 'validated' });
    expect(store.current.status).toBe('building');
    expect(store.current.repairAttempts).toBe(1);
  });

  it('VT-20 / PBI-014 (d) suspends after the second invalid plan and starts no implementer', async () => {
    const broken = { ...validFullPlan, tasks: validFullPlan.tasks.map((task) => ({ ...task, ownedFiles: ['src/shared.ts'] })) };
    const store = new MemoryStore(view());
    const { deps, requests } = harness(store, { files: [JSON.stringify(broken), JSON.stringify(broken), JSON.stringify(validFullPlan)] });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    await finish(store, deps);
    const second = await finish(store, deps);
    expect(second).toEqual({ status: 'suspended', reason: 'plan_invalid' });
    expect(store.current.repairAttempts).toBe(2);
    expect(store.current.suspendReason).toBe('plan_invalid');
    expect(store.current.implementerCount).toBe(0);
    expect(requests).toHaveLength(2);
    const invalid = store.events.find((event) => event.eventType === 'plan.invalid');
    expect(invalid?.message).toContain('Ada and Bo');
    expect(invalid?.message).toContain('src/shared.ts');
    expect(planInvalidNotice({ kind: 'validation', contacts: ['Ada', 'Bo'] })).toContain('failed our checks twice');
  });

  it('VT-21 counts a missing plan file as one repair and says the planner stopped', async () => {
    const store = new MemoryStore(view());
    const { deps, requests } = harness(store, { files: [null, null] });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    await finish(store, deps, 'error');
    expect(store.current.repairAttempts).toBe(1);
    expect(store.events.some((event) => event.eventType === 'plan.repair_requested')).toBe(true);
    const second = await finish(store, deps);
    expect(second).toEqual({ status: 'suspended', reason: 'plan_invalid' });
    expect(store.events.find((event) => event.eventType === 'plan.invalid')?.message).toContain('stopped before it wrote one');
    expect(requests).toHaveLength(2);
  });

  it('VT-22 a repeated completion does not count a second repair', async () => {
    const store = new MemoryStore(view());
    const { deps } = harness(store, { files: [JSON.stringify(validFullPlan)] });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const agentRunId = store.current.planner!.agentRunId!;
    const [first, second] = await Promise.all([
      applyPlannerCompletion({ buildRunId: 'run-1', agentRunId, agentStatus: 'finished' }, deps),
      applyPlannerCompletion({ buildRunId: 'run-1', agentRunId, agentStatus: 'finished' }, deps),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual(['ignored', 'validated']);
    expect(store.current.repairAttempts).toBe(0);
    expect(store.current.planTasks.filter((task) => task.taskKey === 'api')).toHaveLength(1);
  });

  it('VT-23 ignores a completion after the run leaves planning', async () => {
    const store = new MemoryStore(view({ status: 'cancelled' }));
    const { deps, requests } = harness(store);
    store.current.planner = {
      id: 'planner-1',
      status: 'running',
      attempt: 1,
      agentRunId: 'agent-9',
      startedAtMs: 1,
    };
    const ignored = await applyPlannerCompletion({
      buildRunId: 'run-1',
      agentRunId: 'agent-9',
      agentStatus: 'finished',
    }, deps);
    expect(ignored).toEqual({ status: 'ignored' });
    expect(store.current.status).toBe('cancelled');
    expect(store.current.plan).toBeNull();
    expect(store.current.repairAttempts).toBe(0);
    expect(requests).toHaveLength(0);

    store.current.status = 'suspended';
    store.current.suspendReason = 'flag_disabled';
    store.current.suspendedFromStatus = 'planning';
    const switched = await applyPlannerCompletion({
      buildRunId: 'run-1',
      agentRunId: 'agent-9',
      agentStatus: 'finished',
    }, deps);
    expect(switched).toEqual({ status: 'ignored' });
    expect(store.current.suspendReason).toBe('flag_disabled');
  });

  it('VT-24 / PBI-014 (c) a small revision launches no planner and no scaffold', async () => {
    const store = new MemoryStore(view({ classification: 'small' as BuildClassification }));
    const { deps, requests } = harness(store);
    const result = await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(result).toEqual({ status: 'small_path' });
    expect(requests).toHaveLength(0);
    expect(store.current.planner).toBeNull();
    expect(store.current.status).toBe('building');
    expect(store.events.find((event) => event.eventType === 'plan.started')?.detail).toMatchObject({ path: 'small' });
    expect(store.current.planTasks).toHaveLength(0);
  });

  it('VT-25 resume launches again without raising the repair count', async () => {
    const store = new MemoryStore(view({
      status: 'suspended',
      suspendReason: 'flag_disabled',
      suspendedFromStatus: 'planning',
      repairAttempts: 1,
      planner: { id: 'planner-1', status: 'running', attempt: 1, agentRunId: 'agent-old', startedAtMs: 1 },
    }));
    const { deps, requests, releases } = harness(store);
    const result = await resumePlanning({ buildRunId: 'run-1' }, deps);
    expect(result).toEqual({ status: 'launched', attempt: 2 });
    expect(store.current.repairAttempts).toBe(1);
    expect(store.current.status).toBe('planning');
    expect(requests).toHaveLength(1);
    expect(releases).toEqual([['agent-old', 'cancelled']]);

    store.current.planValidation = { status: 'pass', violations: [] };
    const again = await resumePlanning({ buildRunId: 'run-1' }, deps);
    expect(again).toEqual({ status: 'already_planned' });
  });

  it('VT-26 a refused repair launch suspends and does not start attempt 2', async () => {
    const broken = { ...validFullPlan, tasks: validFullPlan.tasks.map((task) => ({ ...task, ownedFiles: ['src/shared.ts'] })) };
    const store = new MemoryStore(view());
    const { deps, requests } = harness(store, { files: [JSON.stringify(broken)], refuseOnLaunch: 2 });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const result = await finish(store, deps);
    expect(result).toEqual({ status: 'suspended', reason: 'flag_disabled' });
    expect(store.current.repairAttempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it('VT-27 a missing model refuses the launch before the SDK call', async () => {
    const store = new MemoryStore(view({ skillSnapshot: snapshot(' ') }));
    const { deps, requests } = harness(store);
    const result = await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(result).toEqual({ status: 'refused', reason: 'configuration' });
    expect(requests).toHaveLength(0);
    expect(store.current.status).toBe('suspended');
    expect(store.current.suspendReason).toBe('configuration');
  });

  it('VT-29 / PBI-015 (c) records a justification without using a repair', async () => {
    const store = new MemoryStore(view({
      classification: 'small',
      status: 'building',
      requirements: [requirement('AC-1')],
      riskDecisions: [],
    }));
    const { deps } = harness(store);
    const result = await validateAndRecordPlan({
      buildRunId: 'run-1',
      revisionNumber: 1,
      rawPlan: validJustifiedPlan,
      source: 'small_agent',
    }, deps);
    expect(result.ok).toBe(true);
    expect(store.current.status).toBe('building');
    expect(store.current.repairAttempts).toBe(0);
    expect(JSON.stringify(store.current.plan)).toContain('Nothing reusable exists');
    expect(store.events.some((event) => event.eventType === 'plan.recorded_small')).toBe(true);
  });

  it('a failed plan file read changes nothing and can be retried', async () => {
    const store = new MemoryStore(view());
    const { deps, requests } = harness(store);
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    deps.readPlanFile = async () => {
      throw new Error('ADO timed out');
    };
    const deferred = await finish(store, deps);
    expect(deferred).toEqual({ status: 'deferred' });
    expect(store.current.repairAttempts).toBe(0);
    expect(store.current.planner?.status).toBe('running');
    expect(requests).toHaveLength(1);

    deps.readPlanFile = async () => JSON.stringify(validFullPlan);
    expect(await finish(store, deps)).toEqual({ status: 'validated' });
  });

  it('start planning leaves a plan_invalid run suspended', async () => {
    const store = new MemoryStore(view({
      status: 'suspended',
      suspendReason: 'plan_invalid',
      suspendedFromStatus: 'planning',
      repairAttempts: 2,
    }));
    const { deps, requests } = harness(store);
    const result = await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(result).toEqual({ status: 'not_planning', runStatus: 'suspended', suspendReason: 'plan_invalid' });
    expect(store.current.suspendReason).toBe('plan_invalid');
    expect(requests).toHaveLength(0);
  });

  it('a suspended small run stays suspended on start and is refused on a non-resumable resume', async () => {
    const store = new MemoryStore(view({
      classification: 'small',
      status: 'suspended',
      suspendReason: 'plan_invalid',
      suspendedFromStatus: 'planning',
    }));
    const { deps } = harness(store);
    expect((await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps)).status).toBe('not_planning');
    expect((await resumePlanning({ buildRunId: 'run-1' }, deps)).status).toBe('not_planning');
    expect(store.current.status).toBe('suspended');
    expect(store.current.suspendReason).toBe('plan_invalid');
  });

  it('a full revision does not accept a small plan', async () => {
    const store = new MemoryStore(view());
    const { scaffoldManifest: _scaffold, ...rest } = validFullPlan;
    const smallPlan = { ...rest, classification: 'small' as const };
    const { deps } = harness(store, { files: [JSON.stringify(smallPlan), JSON.stringify(validFullPlan)] });
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const first = await finish(store, deps);
    expect(first.status).toBe('repair_requested');
    expect(store.current.status).toBe('planning');
    expect(store.current.planValidation?.violations.some((row) => row.path === 'classification')).toBe(true);
  });

  it('every task in a chain records the first chain task as its head', () => {
    const task = (key: string, blockers: string[], runMode: 'chain' | 'own_agent') => ({
      key,
      role: 'implementer' as const,
      blockers,
      ownedFiles: [`src/${key}.ts`],
      reuse: [{ path: 'src/shared/x.ts' }],
      runMode,
      covers: ['AC-1'],
    });
    const stored = toStoredTasks({
      classification: 'small',
      tasks: [
        task('setup', [], 'own_agent'),
        task('a', ['setup'], 'chain'),
        task('b', ['setup', 'a'], 'chain'),
        task('c', ['b'], 'chain'),
      ],
    } as BuildPlan);
    const heads = Object.fromEntries(stored.map((row) => [row.taskKey, row.chainHeadKey]));
    expect(heads).toEqual({ setup: null, a: 'a', b: 'a', c: 'a' });
  });

  it('a cancel that lands before the claim is not overwritten to building', async () => {
    const store = new MemoryStore(view());
    const { deps } = harness(store);
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    const claim = store.claimAndApply.bind(store);
    store.claimAndApply = async (...args) => {
      store.current.status = 'cancelled';
      return claim(...args);
    };
    expect(await finish(store, deps)).toEqual({ status: 'ignored' });
    expect(store.current.status).toBe('cancelled');
    expect(store.current.planTasks).toHaveLength(0);
    expect(store.current.planValidation).toBeNull();
  });

  it('a second start while a launch is in progress does not launch again', async () => {
    const store = new MemoryStore(view());
    const { deps, requests } = harness(store);
    const launch = deps.launch;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.launch = async (request) => {
      await gate;
      return launch(request);
    };
    const first = startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.current.planner?.status).toBe('ready');
    expect(await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps)).toEqual({ status: 'launched', attempt: 1 });
    expect(await resumePlanning({ buildRunId: 'run-1' }, deps)).toEqual({ status: 'launched', attempt: 1 });
    release();
    expect(await first).toEqual({ status: 'launched', attempt: 1 });
    expect(requests).toHaveLength(1);
    expect(store.current.planner?.status).toBe('running');
  });

  it('a cancel during the launch ends the new agent run', async () => {
    const store = new MemoryStore(view());
    const { deps, releases } = harness(store);
    const launch = deps.launch;
    deps.launch = async (request) => {
      const result = await launch(request);
      store.current.status = 'cancelled';
      return result;
    };
    const result = await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(result).toEqual({ status: 'not_planning', runStatus: 'cancelled', suspendReason: null });
    expect(releases).toEqual([['agent-1', 'cancelled']]);
    expect(store.current.planner?.status).toBe('failed');
  });

  it('relaunches when a ready planner is older than the stale window', async () => {
    const store = new MemoryStore(view({
      status: 'planning',
      planner: { id: 'planner-1', status: 'ready', attempt: 1, agentRunId: null, startedAtMs: 0 },
    }));
    const { deps, requests } = harness(store, { now: () => PLANNER_READY_STALE_MS + 1 });
    expect(await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps)).toEqual({ status: 'launched', attempt: 2 });
    expect(requests).toHaveLength(1);
  });

  it('a passing plan ends its agent run', async () => {
    const store = new MemoryStore(view());
    const { deps, releases } = harness(store);
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(await finish(store, deps)).toEqual({ status: 'validated' });
    expect(releases).toEqual([['agent-1', 'completed']]);
  });

  it('accepts a plan committed before the agent ended in error', async () => {
    const store = new MemoryStore(view());
    const { deps, requests, releases } = harness(store);
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(await finish(store, deps, 'error')).toEqual({ status: 'validated' });
    expect(store.current.status).toBe('building');
    expect(store.current.repairAttempts).toBe(0);
    expect(requests).toHaveLength(1);
    expect(releases).toEqual([['agent-1', 'failed']]);
  });

  it('a cancelled planner run is ended before the next launch', async () => {
    const store = new MemoryStore(view());
    const { deps, requests, releases } = harness(store);
    await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps);
    expect(await finish(store, deps, 'cancelled')).toEqual({ status: 'ignored' });
    expect(store.current.planner?.status).toBe('failed');
    expect(releases).toEqual([['agent-1', 'cancelled']]);

    expect(await resumePlanning({ buildRunId: 'run-1' }, deps)).toEqual({ status: 'launched', attempt: 2 });
    expect(requests).toHaveLength(2);
    expect(releases).toEqual([['agent-1', 'cancelled']]);
  });

  it('a launch error leaves the planner failed so the next attempt can start', async () => {
    const store = new MemoryStore(view());
    const { deps } = harness(store);
    const launch = deps.launch;
    deps.launch = async () => {
      throw new Error('SDK down');
    };
    await expect(startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps)).rejects.toThrow('SDK down');
    expect(store.current.planner?.status).toBe('failed');
    deps.launch = launch;
    expect(await startPlanning({ buildRunId: 'run-1', revisionNumber: 1 }, deps)).toEqual({ status: 'launched', attempt: 2 });
  });
});
