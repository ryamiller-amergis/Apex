import {
  DispatchInputError,
  selectNextLaunches,
  type DispatchTask,
} from '../services/buildOrchestrator/dispatcher';
import type { BuildTaskStatus } from '../../shared/types/build';

function task(key: string, status: BuildTaskStatus, blockers: string[] = [], chainHeadKey: string | null = null): DispatchTask {
  return { key, status, blockers, chainHeadKey };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('selectNextLaunches (TBI-018)', () => {
  it('VT-01 PBI-020 AC-0: two independent pending tasks launch as two separate units', () => {
    const decision = selectNextLaunches({
      tasks: [task('a', 'pending'), task('b', 'pending')],
      parallelismLimit: 4,
    });
    expect(decision.promote).toEqual(['a', 'b']);
    expect(decision.launch).toEqual([
      { headKey: 'a', taskKeys: ['a'], mode: 'own_agent' },
      { headKey: 'b', taskKeys: ['b'], mode: 'own_agent' },
    ]);
    expect(decision.waiting).toEqual([]);
  });

  it('VT-02 PBI-020 AC-2 / DoD-0: a saved chain of three runs as one unit in order and uses one slot', () => {
    const decision = selectNextLaunches({
      tasks: [
        task('c', 'pending', ['b'], 'a'),
        task('a', 'pending', [], 'a'),
        task('b', 'pending', ['a'], 'a'),
      ],
      parallelismLimit: 1,
    });
    expect(decision.launch).toEqual([{ headKey: 'a', taskKeys: ['a', 'b', 'c'], mode: 'chain' }]);
    expect(decision.waiting).toEqual([]);
  });

  it('VT-03 TBI-018 DoD-1: a joined task launches only once every blocker is merged or omitted', () => {
    const blocked = selectNextLaunches({
      tasks: [task('a', 'merged'), task('b', 'running'), task('d', 'pending', ['a', 'b'])],
      parallelismLimit: 4,
    });
    expect(blocked.promote).toEqual([]);
    expect(blocked.launch).toEqual([]);

    const merged = selectNextLaunches({
      tasks: [task('a', 'merged'), task('b', 'merged'), task('d', 'pending', ['a', 'b'])],
      parallelismLimit: 4,
    });
    expect(merged.launch.map((unit) => unit.headKey)).toEqual(['d']);

    const omitted = selectNextLaunches({
      tasks: [task('a', 'merged'), task('b', 'omitted'), task('d', 'pending', ['a', 'b'])],
      parallelismLimit: 4,
    });
    expect(omitted.launch.map((unit) => unit.headKey)).toEqual(['d']);
  });

  it('VT-03 TBI-018 DoD-1: a failed blocker keeps its dependents pending', () => {
    const decision = selectNextLaunches({
      tasks: [task('a', 'failed'), task('b', 'pending', ['a'])],
      parallelismLimit: 4,
    });
    expect(decision.promote).toEqual([]);
    expect(decision.launch).toEqual([]);
  });

  it('VT-04 TBI-018 DoD-2: the cap holds extra units as waiting and never suspends', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => task(key, 'ready'));
    const capped = selectNextLaunches({ tasks: six, parallelismLimit: 4 });
    expect(capped.launch).toHaveLength(4);
    expect(capped.waiting).toEqual([
      { headKey: 'e', reason: 'cap' },
      { headKey: 'f', reason: 'cap' },
    ]);

    const threeRunning = selectNextLaunches({
      tasks: [task('a', 'running'), task('b', 'running'), task('c', 'running'), task('d', 'ready'), task('e', 'ready')],
      parallelismLimit: 4,
    });
    expect(threeRunning.runningUnits).toBe(3);
    expect(threeRunning.launch.map((unit) => unit.headKey)).toEqual(['d']);

    expect(selectNextLaunches({ tasks: six, parallelismLimit: 6 }).launch).toHaveLength(6);
  });

  it('VT-04 property: running plus launched never exceeds the cap and no launched task has an unmerged blocker', () => {
    const statuses: BuildTaskStatus[] = ['pending', 'ready', 'running', 'merged', 'omitted', 'failed'];
    for (let seed = 1; seed <= 200; seed += 1) {
      let state = seed;
      const next = (max: number) => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state % max;
      };
      const count = 1 + next(15);
      const tasks: DispatchTask[] = [];
      for (let i = 0; i < count; i += 1) {
        const blockers = tasks.filter(() => next(4) === 0).map((earlier) => earlier.key);
        const done = blockers.every((key) => ['merged', 'omitted'].includes(tasks.find((t) => t.key === key)!.status));
        const status = done ? statuses[next(statuses.length)] : (['pending', 'failed'] as const)[next(2)];
        tasks.push(task(`t${i}`, status, blockers));
      }
      const limit = 1 + next(6);
      const decision = selectNextLaunches({ tasks, parallelismLimit: limit });
      expect(decision.runningUnits + decision.launch.length).toBeLessThanOrEqual(Math.max(limit, decision.runningUnits));
      for (const unit of decision.launch) {
        for (const key of unit.taskKeys) {
          for (const blocker of tasks.find((t) => t.key === key)!.blockers) {
            expect(['merged', 'omitted']).toContain(tasks.find((t) => t.key === blocker)!.status);
          }
        }
      }
    }
  });

  it('VT-05 TBI-018 DoD-3: the same plan in any order gives the same answer, longest path first', () => {
    const tasks = [
      task('a', 'pending'),
      task('b', 'pending'),
      task('c', 'pending', ['b']),
      task('d', 'pending', ['c']),
      task('e', 'pending'),
    ];
    const expected = selectNextLaunches({ tasks, parallelismLimit: 2 });
    expect(expected.launch.map((unit) => unit.headKey)).toEqual(['b', 'a']);
    for (const seed of [3, 7, 11]) {
      expect(selectNextLaunches({ tasks: shuffled(tasks, seed), parallelismLimit: 2 })).toEqual(expected);
    }
  });

  it('VT-05 TBI-018 DoD-3: a 50-task plan is selected in under 50 ms', () => {
    const tasks = Array.from({ length: 50 }, (_, i) =>
      task(`t${i}`, 'pending', i >= 5 ? [`t${i - 5}`, `t${(i * 7) % i}`].filter((key, idx, all) => all.indexOf(key) === idx) : []));
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) selectNextLaunches({ tasks, parallelismLimit: 6 });
    expect((performance.now() - started) / 10).toBeLessThan(50);
  });

  it('throws DispatchInputError on an unknown blocker, a missing chain head, or a partly merged chain', () => {
    expect(() => selectNextLaunches({ tasks: [task('a', 'pending', ['ghost'])], parallelismLimit: 1 }))
      .toThrow(DispatchInputError);
    expect(() => selectNextLaunches({ tasks: [task('a', 'pending', [], 'ghost')], parallelismLimit: 1 }))
      .toThrow(DispatchInputError);
    expect(() => selectNextLaunches({
      tasks: [task('a', 'merged', [], 'a'), task('b', 'running', ['a'], 'a')],
      parallelismLimit: 1,
    })).toThrow(DispatchInputError);
  });
});
