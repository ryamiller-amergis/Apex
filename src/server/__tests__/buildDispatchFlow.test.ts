import { taskBranchName, type BuildRunStatus, type BuildSuspendReason, type BuildTaskRole, type BuildTaskStatus } from '../../shared/types/build';
import type { AppendBuildEventInput } from '../services/buildEventsService';
import {
  createCompletionHandler,
  createCompletionWatcher,
} from '../services/buildOrchestrator/applyCompletion';
import { createDispatchNext } from '../services/buildOrchestrator/dispatchRun';
import {
  AGENT_STAGE_STATUSES,
  BUILD_REPAIR_ATTEMPT_CAP,
  type BuildAgentRunRow,
  type ClaimRequest,
  type DispatchRunRow,
  type DispatchStore,
  type DispatchTaskRow,
} from '../services/buildOrchestrator/dispatchStore';
import type { BuildFlagState, GuardRun, LaunchGuardDecision } from '../services/buildOrchestrator/launchGuard';
import { createBuildReconciler } from '../services/buildOrchestrator/reconcile';
import { createTaskFailurePolicy } from '../services/buildOrchestrator/taskFailure';
import {
  createTaskLauncher,
  type BuildTaskLaunchRequest,
  type BuildTaskLaunchResult,
} from '../services/buildOrchestrator/taskLauncher';

const RUN_ID = 'run-1';
const REVISION_ID = 'rev-1';

type MemoryTask = DispatchTaskRow & { revisionId: string; startedAt: string | null };
type MemoryAgentRun = BuildAgentRunRow & { seq: number };

/** Follows the same conditional-update rules as the Drizzle store. */
class MemoryDispatchStore implements DispatchStore {
  runs = new Map<string, DispatchRunRow>();
  tasks: MemoryTask[] = [];
  agentRuns: MemoryAgentRun[] = [];
  events: AppendBuildEventInput[] = [];
  repairAttempts = new Map<string, number>();
  sweepLocked = false;
  private seq = 0;

  addRun(overrides: Partial<DispatchRunRow> = {}): DispatchRunRow {
    const run: DispatchRunRow = {
      id: RUN_ID,
      status: 'building',
      suspendReason: null,
      project: 'Apex',
      requesterUserId: 'user-1',
      parallelismCap: 4,
      revisionId: REVISION_ID,
      ...overrides,
    };
    this.runs.set(run.id, run);
    return run;
  }

  addTask(key: string, status: BuildTaskStatus, blockers: string[] = [], chainHeadKey: string | null = null,
    role: BuildTaskRole = 'implementer'): MemoryTask {
    const row: MemoryTask = {
      id: `task-${key}`,
      key,
      role,
      status,
      attempt: 1,
      blockers,
      chainHeadKey,
      branchName: null,
      revisionId: REVISION_ID,
      startedAt: status === 'running' || status === 'merged' ? '2026-10-30T00:00:00.000Z' : null,
    };
    this.tasks.push(row);
    return row;
  }

  addAgentRun(taskId: string, status = 'running'): string {
    this.seq += 1;
    const id = `agent-${this.seq}`;
    this.agentRuns.push({
      id,
      status,
      buildTaskId: taskId,
      projectId: 'Apex',
      cloudAgentIdentity: `bc-${id}`,
      dispatchMessageId: `msg-${id}`,
      seq: this.seq,
    });
    return id;
  }

  task(key: string): MemoryTask {
    return this.tasks.find((row) => row.key === key)!;
  }

  run(): DispatchRunRow {
    return this.runs.get(RUN_ID)!;
  }

  eventTypes(): string[] {
    return this.events.map((event) => event.eventType);
  }

  setAgentStatus(id: string, status: string): void {
    this.agentRuns.find((row) => row.id === id)!.status = status;
  }

  private move(taskIds: string[], from: BuildTaskStatus, to: BuildTaskStatus): number {
    let moved = 0;
    for (const row of this.tasks) {
      if (taskIds.includes(row.id) && row.status === from) {
        row.status = to;
        moved += 1;
      }
    }
    return moved;
  }

  private strip(row: MemoryTask): DispatchTaskRow {
    const { revisionId: _revisionId, startedAt: _startedAt, ...rest } = row;
    return { ...rest, blockers: [...rest.blockers] };
  }

  private strippedAgent(row: MemoryAgentRun): BuildAgentRunRow {
    const { seq: _seq, ...rest } = row;
    return { ...rest };
  }

  async loadRun(buildRunId: string) {
    const run = this.runs.get(buildRunId);
    return run ? { ...run } : null;
  }

  async loadPlanTasks(revisionId: string) {
    return this.tasks
      .filter((row) => row.revisionId === revisionId && (row.role === 'implementer' || row.role === 'qa'))
      .map((row) => this.strip(row));
  }

  async loadRevisionTasks(revisionId: string) {
    return this.tasks.filter((row) => row.revisionId === revisionId).map((row) => this.strip(row));
  }

  async loadTaskContext(taskId: string) {
    const row = this.tasks.find((candidate) => candidate.id === taskId);
    return row ? { task: this.strip(row), buildRunId: RUN_ID, revisionId: row.revisionId } : null;
  }

  async loadAgentRun(agentRunId: string) {
    const row = this.agentRuns.find((candidate) => candidate.id === agentRunId);
    return row ? this.strippedAgent(row) : null;
  }

  async latestAgentRunForTask(taskId: string) {
    const rows = this.agentRuns.filter((row) => row.buildTaskId === taskId).sort((a, b) => b.seq - a.seq);
    return rows[0] ? this.strippedAgent(rows[0]) : null;
  }

  async promote(taskIds: string[]) {
    this.move(taskIds, 'pending', 'ready');
  }

  async claim(request: ClaimRequest) {
    const heads = new Set(this.tasks
      .filter((row) => row.status === 'running' && (row.role === 'implementer' || row.role === 'qa'))
      .map((row) => row.chainHeadKey ?? row.key));
    if (heads.size >= request.parallelismLimit) return null;
    const members = this.tasks.filter((row) => request.taskIds.includes(row.id));
    if (members.length !== request.taskIds.length || members.some((row) => row.status !== 'ready')) return null;
    const head = this.tasks.find((row) => row.id === request.headTaskId)!;
    const attempt = head.startedAt ? head.attempt + 1 : head.attempt;
    const branchName = `${taskBranchName(request.buildRunId, request.headKey)}-${attempt}`;
    for (const row of members) {
      row.status = 'running';
      row.attempt = attempt;
      row.startedAt = '2026-10-30T01:00:00.000Z';
    }
    head.branchName = branchName;
    return { attempt, branchName };
  }

  async resetToReady(taskIds: string[]) {
    return this.move(taskIds, 'running', 'ready');
  }

  async markFailed(taskIds: string[]) {
    return this.move(taskIds, 'running', 'failed');
  }

  async requeue(taskIds: string[]) {
    return this.move(taskIds, 'failed', 'ready');
  }

  async consumeRepairAttempt(revisionId: string) {
    const used = this.repairAttempts.get(revisionId) ?? 0;
    if (used >= BUILD_REPAIR_ATTEMPT_CAP) return 'none_left' as const;
    this.repairAttempts.set(revisionId, used + 1);
    return 'attempt_left' as const;
  }

  async suspend(buildRunId: string, reason: BuildSuspendReason) {
    const run = this.runs.get(buildRunId);
    if (!run || !(AGENT_STAGE_STATUSES as readonly string[]).includes(run.status)) return false;
    run.status = 'suspended';
    run.suspendReason = reason;
    this.events.push({ buildRunId, eventType: 'run.suspended', message: reason, detail: { reason } });
    return true;
  }

  async appendEvent(input: AppendBuildEventInput) {
    if (input.dedupeKey && this.events.some((event) =>
      event.buildRunId === input.buildRunId && event.dedupeKey === input.dedupeKey)) {
      return false;
    }
    this.events.push(input);
    return true;
  }

  async listRuns(statuses: readonly BuildRunStatus[]) {
    return [...this.runs.values()].filter((run) => statuses.includes(run.status)).map((run) => ({ ...run }));
  }

  async listRunsSuspendedFor(reason: BuildSuspendReason) {
    return [...this.runs.values()]
      .filter((run) => run.status === 'suspended' && run.suspendReason === reason)
      .map((run) => ({ ...run }));
  }

  async listRunningHeadAgentRunIds() {
    const ids: string[] = [];
    for (const row of this.tasks) {
      if (row.status !== 'running' || (row.chainHeadKey ?? row.key) !== row.key) continue;
      if (row.role !== 'implementer' && row.role !== 'qa') continue;
      const latest = await this.latestAgentRunForTask(row.id);
      if (latest) ids.push(latest.id);
    }
    return ids;
  }

  async withSweepLock<T>(fn: () => Promise<T>) {
    if (this.sweepLocked) return null;
    return fn();
  }

  async loadUserEmail() {
    return 'member@example.com';
  }
}

function harness() {
  const store = new MemoryDispatchStore();
  const track = jest.fn();
  const launches: BuildTaskLaunchRequest[] = [];
  let launchResult: (request: BuildTaskLaunchRequest) => BuildTaskLaunchResult = (request) => {
    const agentRunId = store.addAgentRun(request.tasks[0].id);
    return { kind: 'launched', agentRunId, cloudAgentId: `bc-${agentRunId}`, cursorRunId: `msg-${agentRunId}` };
  };
  const guard = jest.fn(async (): Promise<LaunchGuardDecision> => ({ outcome: 'allow' }));
  const failTask = createTaskFailurePolicy({ store, track });
  const dispatchNext = createDispatchNext({
    store,
    guard,
    launch: async (request) => {
      launches.push(request);
      return launchResult(request);
    },
    failTask,
    track,
  });
  const dispatchSpy = jest.fn((buildRunId: string) => dispatchNext(buildRunId));
  const requestMerge = jest.fn(async () => undefined);
  const mayReportDone = jest.fn(async () => true);
  const observe = jest.fn(async () => ({ status: 'running', prUrl: null, resultText: null, settled: false }));
  const markTerminal = jest.fn(async (agentRunId: string, status: string) => store.setAgentStatus(agentRunId, status));
  const applyCompletion = createCompletionHandler({
    store,
    observe,
    markTerminal,
    mayReportDone,
    requestMerge,
    failTask,
    dispatchNext: dispatchSpy,
    track,
  });
  const cancelAgent = jest.fn(async (agentRun: BuildAgentRunRow) => store.setAgentStatus(agentRun.id, 'cancelled'));
  const readFlag = jest.fn(async (_run: GuardRun): Promise<BuildFlagState> => 'on');
  const reconcile = createBuildReconciler({
    store,
    readFlag,
    applyCompletion,
    dispatchNext: dispatchSpy,
    cancelAgent,
    track,
    logError: jest.fn(),
  });
  return {
    store,
    track,
    launches,
    guard,
    dispatchNext,
    dispatchSpy,
    requestMerge,
    mayReportDone,
    observe,
    markTerminal,
    applyCompletion,
    cancelAgent,
    readFlag,
    reconcile,
    setLaunchResult(fn: typeof launchResult) {
      launchResult = fn;
    },
  };
}

describe('dispatchNext (TBI-018, PBI-020)', () => {
  it('PBI-020 AC-0: two independent tasks each launch in their own agent', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'pending');
    h.store.addTask('b', 'pending');

    const outcome = await h.dispatchNext(RUN_ID);

    expect(outcome).toEqual({ kind: 'dispatched', promoted: ['a', 'b'], launched: ['a', 'b'], waiting: [] });
    expect(h.launches.map((request) => request.unit.taskKeys)).toEqual([['a'], ['b']]);
    expect(h.store.agentRuns.map((row) => row.buildTaskId)).toEqual(['task-a', 'task-b']);
    expect(h.store.task('a').branchName).toBe(`${taskBranchName(RUN_ID, 'a')}-1`);
    expect(h.store.eventTypes()).toEqual(['task.launched', 'task.launched']);
  });

  it('PBI-020 AC-2: a chain of three launches once and every member runs in that agent', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'pending', [], 'a');
    h.store.addTask('b', 'pending', ['a'], 'a');
    h.store.addTask('c', 'pending', ['b'], 'a');

    await h.dispatchNext(RUN_ID);

    expect(h.launches).toHaveLength(1);
    expect(h.launches[0].unit).toEqual({ headKey: 'a', taskKeys: ['a', 'b', 'c'], mode: 'chain' });
    expect(h.launches[0].tasks.map((task) => task.key)).toEqual(['a', 'b', 'c']);
    expect(['a', 'b', 'c'].map((key) => h.store.task(key).status)).toEqual(['running', 'running', 'running']);
    expect(h.store.agentRuns).toHaveLength(1);
  });

  it('TBI-018 DoD-2: never launches past the frozen cap', async () => {
    const h = harness();
    h.store.addRun({ parallelismCap: 2 });
    h.store.addTask('a', 'running');
    h.store.addTask('b', 'ready');
    h.store.addTask('c', 'ready');

    const outcome = await h.dispatchNext(RUN_ID);

    expect(outcome).toMatchObject({ kind: 'dispatched', launched: ['b'], waiting: ['c'] });
    expect(h.store.task('c').status).toBe('ready');
    expect(h.store.run().status).toBe('building');
  });

  it.each([
    ['VT-06/VT-07 PBI-021 AC-0', 'flag_disabled' as const],
    ['VT-08 PBI-020 AC-3', 'permission_revoked' as const],
  ])('%s: a refused guard claims nothing, launches nothing, and suspends with %s', async (_label, reason) => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'ready');
    h.guard.mockResolvedValueOnce({ outcome: 'refuse', reason });

    const outcome = await h.dispatchNext(RUN_ID);

    expect(outcome).toEqual({ kind: 'suspended', reason });
    expect(h.launches).toHaveLength(0);
    expect(h.store.task('a').status).toBe('ready');
    expect(h.store.run()).toMatchObject({ status: 'suspended', suspendReason: reason });
    expect(h.store.eventTypes()).toEqual(['run.suspended']);
  });

  it('VT-09: a lookup error defers the launch, keeps the task ready, and does not suspend', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'ready');
    h.guard.mockResolvedValue({ outcome: 'defer', detail: 'db down' });

    await expect(h.dispatchNext(RUN_ID)).resolves.toEqual({ kind: 'deferred', headKey: 'a' });
    await h.dispatchNext(RUN_ID);

    expect(h.launches).toHaveLength(0);
    expect(h.store.task('a').status).toBe('ready');
    expect(h.store.run().status).toBe('building');
    expect(h.store.eventTypes()).toEqual(['task.launch_deferred']);
  });

  it('VT-11 PBI-020 AC-1: a failed launch marks the task failed, uses a repair attempt, and relaunches on a new branch', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'ready');
    h.setLaunchResult(() => ({ kind: 'failed', detail: 'Cursor is down.' }));

    await h.dispatchNext(RUN_ID);

    expect(h.store.eventTypes()).toEqual(['task.failed', 'task.requeued']);
    expect(h.store.task('a').status).toBe('ready');
    expect(h.store.repairAttempts.get(REVISION_ID)).toBe(1);

    h.setLaunchResult((request) => {
      const agentRunId = h.store.addAgentRun(request.tasks[0].id);
      return { kind: 'launched', agentRunId, cloudAgentId: 'bc', cursorRunId: 'msg' };
    });
    await h.dispatchNext(RUN_ID);

    expect(h.launches.map((request) => request.attempt)).toEqual([1, 2]);
    expect(h.store.task('a')).toMatchObject({ status: 'running', attempt: 2, branchName: `${taskBranchName(RUN_ID, 'a')}-2` });
  });

  it('VT-11 PBI-020 AC-1: with no repair attempt left the task stays failed and the run suspends with repair_cap', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'ready');
    h.store.repairAttempts.set(REVISION_ID, BUILD_REPAIR_ATTEMPT_CAP);
    h.setLaunchResult(() => ({ kind: 'failed', detail: 'Cursor is down.' }));

    await expect(h.dispatchNext(RUN_ID)).resolves.toEqual({ kind: 'suspended', reason: 'repair_cap' });

    expect(h.store.task('a').status).toBe('failed');
    expect(h.store.run()).toMatchObject({ status: 'suspended', suspendReason: 'repair_cap' });
    expect(h.store.eventTypes()).toEqual(['task.failed', 'run.suspended']);
  });

  it('VT-12 PBI-020 AC-1: a snapshot refusal returns tasks to ready and suspends with configuration without using a repair attempt', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'ready');
    h.setLaunchResult(() => ({ kind: 'refused', detail: 'The task launch was refused: snapshot_secret_value.' }));

    await expect(h.dispatchNext(RUN_ID)).resolves.toEqual({ kind: 'suspended', reason: 'configuration' });

    expect(h.store.task('a').status).toBe('ready');
    expect(h.store.run()).toMatchObject({ status: 'suspended', suspendReason: 'configuration' });
    expect(h.store.repairAttempts.get(REVISION_ID)).toBeUndefined();
  });

  it('VT-22: once the last blocker merges, one direct dispatchNext call launches the dependent', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'merged');
    h.store.addTask('b', 'pending', ['a']);

    const outcome = await h.dispatchNext(RUN_ID);

    expect(outcome).toMatchObject({ kind: 'dispatched', promoted: ['b'], launched: ['b'] });
  });

  it('suspends with plan_invalid when the stored tasks are inconsistent', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'merged', [], 'a');
    h.store.addTask('b', 'ready', ['a'], 'a');

    await expect(h.dispatchNext(RUN_ID)).resolves.toEqual({ kind: 'suspended', reason: 'plan_invalid' });
    expect(h.launches).toHaveLength(0);
  });

  it('skips a run that is not building', async () => {
    const h = harness();
    h.store.addRun({ status: 'suspended', suspendReason: 'flag_disabled' });
    h.store.addTask('a', 'ready');
    await expect(h.dispatchNext(RUN_ID)).resolves.toEqual({ kind: 'skipped', reason: 'not_building' });
  });

  it('VT-19 PBI-021 AC-2 (dispatcher half): after resume, unmerged tasks relaunch with attempt + 1 and merged ones stay merged', async () => {
    const h = harness();
    h.store.addRun({ status: 'suspended', suspendReason: 'flag_disabled' });
    h.store.addTask('a', 'merged');
    const b = h.store.addTask('b', 'ready', ['a']);
    const c = h.store.addTask('c', 'ready', ['a']);
    b.startedAt = c.startedAt = '2026-10-30T00:00:00.000Z';
    b.branchName = `${taskBranchName(RUN_ID, 'b')}-1`;

    Object.assign(h.store.run(), { status: 'building', suspendReason: null });
    await h.dispatchNext(RUN_ID);

    expect(h.launches.map((request) => request.unit.headKey)).toEqual(['b', 'c']);
    expect(h.store.task('b')).toMatchObject({ attempt: 2, branchName: `${taskBranchName(RUN_ID, 'b')}-2` });
    expect(h.store.task('c').attempt).toBe(2);
    expect(h.store.task('a').status).toBe('merged');
  });
});

describe('createTaskLauncher (PBI-020 AC-1, VT-12)', () => {
  const request = {
    run: { id: RUN_ID, project: 'Apex', revisionId: REVISION_ID },
    unit: { headKey: 'a', taskKeys: ['a'], mode: 'own_agent' },
    tasks: [],
    attempt: 1,
    branchName: 'b',
  } as unknown as BuildTaskLaunchRequest;

  it('makes no SDK call when the snapshot writer refuses', async () => {
    const launchRun = jest.fn();
    const launch = createTaskLauncher({
      buildCandidate: async () => ({ ok: true, candidate: {} }),
      writeSnapshot: jest.fn(async () => ({ ok: false as const, refused: true as const, refusals: [{ code: 'snapshot_secret_value' as const }] })),
      launchRun,
    });
    await expect(launch(request)).resolves.toEqual({
      kind: 'refused',
      detail: 'The task launch was refused: snapshot_secret_value.',
    });
    expect(launchRun).not.toHaveBeenCalled();
  });

  it('refuses before writing anything when no candidate can be built', async () => {
    const writeSnapshot = jest.fn();
    const launch = createTaskLauncher({
      buildCandidate: async () => ({ ok: false, detail: 'missing model' }),
      writeSnapshot,
    });
    await expect(launch(request)).resolves.toEqual({ kind: 'refused', detail: 'missing model' });
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it('reports a thrown launch as failed', async () => {
    const launch = createTaskLauncher({
      buildCandidate: async () => ({ ok: true, candidate: {} }),
      writeSnapshot: jest.fn(async () => ({ ok: true as const, runId: 'agent-1' })),
      launchRun: jest.fn(async () => { throw new Error('network'); }),
    });
    await expect(launch(request)).resolves.toEqual({ kind: 'failed', detail: 'network' });
  });
});

describe('applyAgentCompletion (TBI-019)', () => {
  function runningTask(h: ReturnType<typeof harness>, agentStatus = 'completed') {
    h.store.addRun();
    h.store.addTask('a', 'running');
    return h.store.addAgentRun('task-a', agentStatus);
  }

  it('VT-13 TBI-019 DoD-0: repeated completions write one event and leave the task unchanged', async () => {
    const h = harness();
    const agentRunId = runningTask(h);

    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('finished');
    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('already_applied');

    expect(h.store.eventTypes()).toEqual(['task.completed']);
    expect(h.requestMerge).toHaveBeenCalledWith({ buildRunId: RUN_ID, headTaskId: 'task-a', taskIds: ['task-a'] });
    expect(h.store.task('a').status).toBe('running');
  });

  it('observes a live agent run and records its end only once Cursor reports it settled', async () => {
    const h = harness();
    const agentRunId = runningTask(h, 'running');

    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('not_settled');
    h.observe.mockResolvedValueOnce({ status: 'finished', prUrl: null, resultText: null, settled: true });
    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('finished');

    expect(h.markTerminal).toHaveBeenCalledWith(agentRunId, 'completed', `msg-${agentRunId}`);
  });

  it.each([
    ['finished without evidence', 'completed', false],
    ['failed', 'failed', true],
    ['cancelled unexpectedly', 'cancelled', true],
  ])('a task whose agent %s is failed, requeued, and dispatched again', async (_label, status, evidence) => {
    const h = harness();
    const agentRunId = runningTask(h, status);
    h.mayReportDone.mockResolvedValue(evidence);

    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('failed');

    expect(h.store.eventTypes()).toEqual(['task.failed', 'task.requeued', 'task.launched']);
    expect(h.requestMerge).not.toHaveBeenCalled();
    expect(h.dispatchSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('VT-21: a late completion from an earlier agent run is ignored', async () => {
    const h = harness();
    const earlier = runningTask(h, 'running');
    h.store.addAgentRun('task-a', 'running');
    h.store.setAgentStatus(earlier, 'completed');

    await expect(h.applyCompletion({ agentRunId: earlier })).resolves.toBe('ignored_superseded');

    expect(h.store.task('a').status).toBe('running');
    expect(h.store.events).toHaveLength(0);
  });

  it('discards the result while the run is suspended for the flag', async () => {
    const h = harness();
    const agentRunId = runningTask(h);
    Object.assign(h.store.run(), { status: 'suspended', suspendReason: 'flag_disabled' });

    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('discarded');

    expect(h.store.task('a').status).toBe('ready');
    expect(h.store.eventTypes()).toEqual(['task.completion_discarded']);
    expect(h.requestMerge).not.toHaveBeenCalled();
  });

  it('only records a completion for a cancelled run', async () => {
    const h = harness();
    const agentRunId = runningTask(h);
    Object.assign(h.store.run(), { status: 'cancelled' });
    await expect(h.applyCompletion({ agentRunId })).resolves.toBe('recorded_only');
    expect(h.store.events).toHaveLength(0);
  });

  it('ignores an agent run with no build task', async () => {
    const h = harness();
    await expect(h.applyCompletion({ agentRunId: 'my-work-run' })).resolves.toBe('ignored_unknown_run');
  });
});

describe('completion watcher (TBI-019 DoD-2)', () => {
  it('applies the completion once the stream ends', async () => {
    const apply = jest.fn(async () => 'finished' as const);
    const watcher = createCompletionWatcher({
      stream: () => (async function* () { yield 'step'; })(),
      apply,
    });
    watcher.watch({ agentRunId: 'agent-1', project: 'Apex', cloudAgentId: 'bc', cursorRunId: 'msg' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(apply).toHaveBeenCalledWith({ agentRunId: 'agent-1' });
    expect(watcher.watching()).toBe(0);
  });

  it('VT-14: a stream that fails mid-run leaves the completion to the sweep, which applies it once', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'running');
    const agentRunId = h.store.addAgentRun('task-a', 'running');
    const logError = jest.fn();
    const watcher = createCompletionWatcher({
      stream: () => ({ next: async () => { throw new Error('stream dropped'); } }),
      apply: h.applyCompletion,
      logError,
    });

    watcher.watch({ agentRunId, project: 'Apex', cloudAgentId: 'bc', cursorRunId: 'msg' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logError).toHaveBeenCalled();

    h.store.setAgentStatus(agentRunId, 'completed');
    await h.reconcile();
    await h.reconcile();

    expect(h.store.eventTypes()).toEqual(['task.completed']);
  });
});

describe('reconcileBuildRuns (TBI-019, PBI-021)', () => {
  function twoRunning(h: ReturnType<typeof harness>) {
    h.store.addRun();
    h.store.addTask('a', 'running');
    h.store.addTask('b', 'running');
    return [h.store.addAgentRun('task-a'), h.store.addAgentRun('task-b')];
  }

  it('VT-17 PBI-021 AC-0: with the flag off one pass cancels both agents, resets both tasks, and suspends the run', async () => {
    const h = harness();
    const agents = twoRunning(h);
    h.readFlag.mockResolvedValue('off');

    const outcome = await h.reconcile();

    expect(h.cancelAgent.mock.calls.map(([agentRun]) => agentRun.id)).toEqual(agents);
    expect([h.store.task('a').status, h.store.task('b').status]).toEqual(['ready', 'ready']);
    expect(h.store.run()).toMatchObject({ status: 'suspended', suspendReason: 'flag_disabled' });
    expect(h.store.eventTypes()).toEqual(['run.suspended']);
    expect(outcome).toMatchObject({ flagSuspended: 1, skipped: false });
  });

  it('VT-18 PBI-021 AC-1: a failed cancel still suspends, writes one event, and is retried without a second event', async () => {
    const h = harness();
    const [first] = twoRunning(h);
    h.readFlag.mockResolvedValue('off');
    h.cancelAgent.mockImplementation(async (agentRun) => {
      if (agentRun.id === first) throw new Error('Cursor refused');
      h.store.setAgentStatus(agentRun.id, 'cancelled');
    });

    await h.reconcile();
    await h.reconcile();

    expect(h.store.run()).toMatchObject({ status: 'suspended', suspendReason: 'flag_disabled' });
    expect(h.store.eventTypes().filter((type) => type === 'agent.cancel_failed')).toHaveLength(1);
    expect(h.cancelAgent.mock.calls.filter(([agentRun]) => agentRun.id === first).length).toBeGreaterThanOrEqual(3);
    expect(h.launches).toHaveLength(0);
  });

  it('runs the flag gate before completions, so a finished agent is not merged once the flag is off', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'running');
    h.store.addAgentRun('task-a', 'completed');
    h.readFlag.mockResolvedValue('off');

    await h.reconcile();

    expect(h.requestMerge).not.toHaveBeenCalled();
    expect(h.store.task('a').status).toBe('ready');
  });

  it('VT-15 TBI-019 DoD-1: after a restart the sweep applies a missed completion and the next task launches after merge', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'merged');
    h.store.addTask('b', 'running', ['a']);
    h.store.addTask('c', 'pending', ['b']);
    h.store.addAgentRun('task-b', 'completed');
    h.requestMerge.mockImplementation(async () => {
      h.store.task('b').status = 'merged';
      await h.dispatchNext(RUN_ID);
    });

    await h.reconcile();

    expect(h.requestMerge).toHaveBeenCalledTimes(1);
    expect(h.launches.map((request) => request.unit.headKey)).toEqual(['c']);
  });

  it('skips the pass when another instance holds the sweep lock', async () => {
    const h = harness();
    twoRunning(h);
    h.store.sweepLocked = true;
    await expect(h.reconcile()).resolves.toMatchObject({ skipped: true, flagSuspended: 0 });
    expect(h.readFlag).not.toHaveBeenCalled();
  });

  it('a failure in one run does not stop the pass for the others', async () => {
    const h = harness();
    h.store.addRun();
    h.store.addTask('a', 'pending');
    h.readFlag.mockRejectedValueOnce(new Error('flag lookup failed'));

    const outcome = await h.reconcile();

    expect(outcome.errors).toBe(1);
    expect(h.launches.map((request) => request.unit.headKey)).toEqual(['a']);
  });
});
