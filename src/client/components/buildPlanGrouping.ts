export interface GroupableTask {
  key: string;
  dependsOn: readonly string[];
}

export interface BlockerGroups<T extends GroupableTask> {
  /** `waves[0]` holds tasks with no blockers; each later wave waits on the one before. */
  waves: T[][];
  /** Tasks that name a blocker not in the plan, sit on a cycle, or wait on such a task. */
  waiting: T[];
}

/** A task's wave is 1 plus the highest wave among its blockers. Always terminates. */
export function groupTasksByBlockers<T extends GroupableTask>(tasks: readonly T[]): BlockerGroups<T> {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const wave = new Map<string, number | null>();
  const visiting = new Set<string>();

  const resolve = (key: string): number | null => {
    if (wave.has(key)) return wave.get(key) ?? null;
    const task = byKey.get(key);
    if (!task || visiting.has(key)) return null;
    visiting.add(key);
    let highest = 0;
    let blocked = false;
    for (const blocker of task.dependsOn) {
      const blockerWave = resolve(blocker);
      if (blockerWave === null) blocked = true;
      else highest = Math.max(highest, blockerWave);
    }
    visiting.delete(key);
    const result = blocked ? null : highest + 1;
    wave.set(key, result);
    return result;
  };

  const waves: T[][] = [];
  const waiting: T[] = [];
  for (const task of tasks) {
    const value = resolve(task.key);
    if (value === null) {
      waiting.push(task);
      continue;
    }
    while (waves.length < value) waves.push([]);
    waves[value - 1].push(task);
  }
  return { waves: waves.filter((group) => group.length > 0), waiting };
}
