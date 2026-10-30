/**
 * Chooses the next build tasks to launch. Pure: no database, clock, or SDK.
 * The same tasks and cap always give the same answer.
 */
import type { BuildTaskStatus } from '../../../shared/types/build';

export interface DispatchTask {
  key: string;
  status: BuildTaskStatus;
  blockers: readonly string[];
  /** Saved by the planner. Tasks that share a head key run in one agent. */
  chainHeadKey: string | null;
}

export interface DispatchInput {
  tasks: readonly DispatchTask[];
  /** Frozen cap, 1 to 6. */
  parallelismLimit: number;
}

export interface LaunchUnit {
  headKey: string;
  /** Chain members in run order, or one key. */
  taskKeys: string[];
  mode: 'own_agent' | 'chain';
}

export interface DispatchDecision {
  /** Pending tasks whose blockers are all merged or omitted. */
  promote: string[];
  /** Never more units than free slots. */
  launch: LaunchUnit[];
  waiting: Array<{ headKey: string; reason: 'cap' }>;
  runningUnits: number;
}

export class DispatchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatchInputError';
  }
}

type UnitState = 'done' | BuildTaskStatus;

interface Unit {
  headKey: string;
  members: DispatchTask[];
  externalBlockers: string[];
  state: UnitState;
}

function isDone(status: BuildTaskStatus): boolean {
  return status === 'merged' || status === 'omitted';
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function orderMembers(headKey: string, members: DispatchTask[]): DispatchTask[] {
  const keys = new Set(members.map((task) => task.key));
  const remaining = new Map(members.map((task) => [
    task.key,
    task.blockers.filter((blocker) => keys.has(blocker)).length,
  ]));
  const ordered: DispatchTask[] = [];
  while (remaining.size > 0) {
    const next = [...remaining.entries()]
      .filter(([, count]) => count === 0)
      .map(([key]) => key)
      .sort(compareKeys)[0];
    if (next === undefined) throw new DispatchInputError(`Chain ${headKey} has a cycle.`);
    remaining.delete(next);
    ordered.push(members.find((task) => task.key === next)!);
    for (const task of members) {
      if (remaining.has(task.key) && task.blockers.includes(next)) {
        remaining.set(task.key, remaining.get(task.key)! - 1);
      }
    }
  }
  if (ordered[0].key !== headKey) {
    throw new DispatchInputError(`Chain ${headKey} does not start at its head.`);
  }
  return ordered;
}

function unitState(headKey: string, members: DispatchTask[]): UnitState {
  const active = members.filter((task) => task.status !== 'omitted');
  if (active.length === 0) return 'done';
  const statuses = new Set(active.map((task) => task.status));
  if (statuses.size > 1) {
    throw new DispatchInputError(`Chain ${headKey} has members in different states.`);
  }
  const [status] = statuses;
  return status === 'merged' ? 'done' : status;
}

function buildUnits(byKey: Map<string, DispatchTask>): Unit[] {
  const grouped = new Map<string, DispatchTask[]>();
  for (const task of byKey.values()) {
    const headKey = task.chainHeadKey ?? task.key;
    if (!byKey.has(headKey)) {
      throw new DispatchInputError(`Task ${task.key} names a chain head that does not exist.`);
    }
    const members = grouped.get(headKey) ?? [];
    members.push(task);
    grouped.set(headKey, members);
  }
  return [...grouped.entries()].map(([headKey, members]) => {
    const ordered = orderMembers(headKey, members);
    const memberKeys = new Set(ordered.map((task) => task.key));
    const externalBlockers = [...new Set(ordered.flatMap((task) => task.blockers))]
      .filter((blocker) => !memberKeys.has(blocker))
      .sort(compareKeys);
    return { headKey, members: ordered, externalBlockers, state: unitState(headKey, ordered) };
  });
}

/** Longest path of unfinished tasks that starts at each task, counting the task itself. */
function remainingDepths(byKey: Map<string, DispatchTask>): Map<string, number> {
  const dependents = new Map<string, string[]>();
  for (const task of byKey.values()) {
    for (const blocker of task.blockers) {
      const list = dependents.get(blocker) ?? [];
      list.push(task.key);
      dependents.set(blocker, list);
    }
  }
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = depths.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) throw new DispatchInputError(`Task ${key} is part of a cycle.`);
    visiting.add(key);
    let longest = 0;
    for (const dependent of dependents.get(key) ?? []) longest = Math.max(longest, visit(dependent));
    visiting.delete(key);
    const depth = longest + (isDone(byKey.get(key)!.status) ? 0 : 1);
    depths.set(key, depth);
    return depth;
  };
  for (const key of byKey.keys()) visit(key);
  return depths;
}

export function selectNextLaunches(input: DispatchInput): DispatchDecision {
  const byKey = new Map<string, DispatchTask>();
  for (const task of input.tasks) {
    if (byKey.has(task.key)) throw new DispatchInputError(`Task ${task.key} appears twice.`);
    byKey.set(task.key, task);
  }
  for (const task of byKey.values()) {
    for (const blocker of task.blockers) {
      if (!byKey.has(blocker)) {
        throw new DispatchInputError(`Task ${task.key} waits on ${blocker}, which does not exist.`);
      }
    }
  }

  const depths = remainingDepths(byKey);
  const units = buildUnits(byKey);
  const doneUnits = new Set(units.filter((unit) => unit.state === 'done').map((unit) => unit.headKey));
  const blockerDone = (key: string) => {
    const blocker = byKey.get(key)!;
    return isDone(blocker.status) || doneUnits.has(blocker.chainHeadKey ?? blocker.key);
  };

  const promote: string[] = [];
  const candidates: Unit[] = [];
  let runningUnits = 0;
  for (const unit of units) {
    if (unit.state === 'running') runningUnits += 1;
    if (unit.state === 'ready') candidates.push(unit);
    if (unit.state === 'pending' && unit.externalBlockers.every(blockerDone)) {
      promote.push(...unit.members.filter((task) => task.status === 'pending').map((task) => task.key));
      candidates.push(unit);
    }
  }

  const unitDepth = (unit: Unit) => Math.max(...unit.members.map((task) => depths.get(task.key) ?? 0));
  candidates.sort((a, b) => unitDepth(b) - unitDepth(a) || compareKeys(a.headKey, b.headKey));

  const freeSlots = Math.max(0, input.parallelismLimit - runningUnits);
  const launch = candidates.slice(0, freeSlots).map((unit): LaunchUnit => ({
    headKey: unit.headKey,
    taskKeys: unit.members.filter((task) => task.status !== 'omitted').map((task) => task.key),
    mode: unit.members.length > 1 ? 'chain' : 'own_agent',
  }));
  const waiting = candidates.slice(freeSlots).map((unit) => ({ headKey: unit.headKey, reason: 'cap' as const }));

  return { promote: promote.sort(compareKeys), launch, waiting, runningUnits };
}
