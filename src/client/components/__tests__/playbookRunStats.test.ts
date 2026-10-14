import type { PlaybookRunStatus, PlaybookRunSummary } from '../../../shared/types/playbook';
import {
  computeRunStats,
  dailyActivity,
  formatDuration,
  formatSuccessRate,
  groupRunsByDefinition,
} from '../playbookRunStats';
import { orderedSteps } from '../playbookStepCatalog';
import { newPlaybookNodeId } from '../../utils/playbookCanvasGraph';

function run(
  status: PlaybookRunStatus,
  startedAt: string,
  completedAt: string | null = null,
  definitionId = 'def-1',
): PlaybookRunSummary {
  return {
    runId: `${definitionId}-${status}-${startedAt}`,
    project: 'Apex',
    definitionId,
    definitionName: 'Demo',
    definitionVersionId: 'ver-1',
    versionNumber: 1,
    status,
    initiatorUserId: 'someone',
    startedAt,
    completedAt,
  };
}

describe('computeRunStats', () => {
  it('leaves cancelled runs out of the success rate', () => {
    const stats = computeRunStats([
      run('completed', '2026-10-10T10:00:00.000Z', '2026-10-10T10:01:00.000Z'),
      run('failed', '2026-10-11T10:00:00.000Z', '2026-10-11T10:03:00.000Z'),
      run('cancelled', '2026-10-12T10:00:00.000Z', '2026-10-12T10:00:30.000Z'),
      run('running', '2026-10-13T10:00:00.000Z'),
      run('suspended', '2026-10-13T11:00:00.000Z'),
    ]);
    expect(stats).toMatchObject({ total: 5, completed: 1, failed: 1, running: 1, waiting: 1 });
    expect(stats.successRate).toBe(0.5);
    expect(stats.averageDurationMs).toBe((60_000 + 180_000 + 30_000) / 3);
    expect(stats.lastRunAt).toBe('2026-10-13T11:00:00.000Z');
  });

  it('reports no rate or duration before any run finishes', () => {
    const stats = computeRunStats([run('running', '2026-10-13T10:00:00.000Z')]);
    expect(stats.successRate).toBeNull();
    expect(stats.averageDurationMs).toBeNull();
    expect(formatSuccessRate(stats.successRate)).toBe('—');
  });
});

describe('dailyActivity', () => {
  it('buckets runs by local day, oldest first, ending today', () => {
    const now = new Date(2026, 9, 13, 15, 0);
    const days = dailyActivity(
      [
        run('completed', new Date(2026, 9, 13, 9, 0).toISOString()),
        run('failed', new Date(2026, 9, 12, 9, 0).toISOString()),
        run('running', new Date(2026, 9, 13, 10, 0).toISOString()),
        run('completed', new Date(2026, 8, 1, 9, 0).toISOString()),
      ],
      3,
      now,
    );
    expect(days.map((day) => day.date)).toEqual(['2026-10-11', '2026-10-12', '2026-10-13']);
    expect(days[1]).toMatchObject({ failed: 1, total: 1 });
    expect(days[2]).toMatchObject({ completed: 1, other: 1, total: 2 });
  });
});

describe('helpers', () => {
  it('groups runs by definition', () => {
    const groups = groupRunsByDefinition([
      run('completed', '2026-10-10T10:00:00.000Z', null, 'a'),
      run('failed', '2026-10-10T11:00:00.000Z', null, 'b'),
      run('running', '2026-10-10T12:00:00.000Z', null, 'a'),
    ]);
    expect(groups.get('a')).toHaveLength(2);
    expect(groups.get('b')).toHaveLength(1);
  });

  it('formats durations from the largest unit', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(190_000)).toBe('3m 10s');
    expect(formatDuration(7_500_000)).toBe('2h 5m');
    expect(formatDuration(100 * 3_600_000)).toBe('4d 4h');
  });

  it('orders steps so each comes after the steps that lead to it', () => {
    const ordered = orderedSteps({
      nodes: [
        { id: 'notify', stepType: 'notify' },
        { id: 'approve', stepType: 'approval-gate' },
        { id: 'ask', stepType: 'cursor-agent' },
      ],
      edges: [
        { from: 'ask', to: 'approve' },
        { from: 'approve', to: 'notify' },
      ],
    });
    expect(ordered.map((node) => node.id)).toEqual(['ask', 'approve', 'notify']);
  });

  it('names new steps after their type with the lowest free suffix', () => {
    expect(newPlaybookNodeId('notify', [])).toBe('notify-1');
    expect(newPlaybookNodeId('notify', ['notify-1', 'notify-3'])).toBe('notify-2');
  });
});
