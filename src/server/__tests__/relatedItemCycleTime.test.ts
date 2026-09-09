import {
  computeLastEnterInProgressToDone,
  summarizeRelatedItemCycleTimes,
} from '../services/relatedItemCycleTime';
import type { RelatedItemCycleTime } from '../../shared/types/relatedItemCycleTime';

function rev(state: string, date: string, revision = 1) {
  return { rev: revision, fields: { 'System.State': state, 'System.ChangedDate': date } };
}

describe('computeLastEnterInProgressToDone', () => {
  it('AC-0 uses last enter In Progress, not first', () => {
    const result = computeLastEnterInProgressToDone([
      rev('New', '2024-01-01T00:00:00Z', 1),
      rev('In Progress', '2024-01-02T00:00:00Z', 2),
      rev('New', '2024-01-03T00:00:00Z', 3),
      rev('In Progress', '2024-01-10T00:00:00Z', 4),
      rev('Done', '2024-01-12T00:00:00Z', 5),
    ]);

    expect(result.lastInProgressAt).toBe('2024-01-10T00:00:00.000Z');
    expect(result.lastDoneAt).toBe('2024-01-12T00:00:00.000Z');
    expect(result.cycleTimeDays).toBe(2);
    expect(result.incompleteReason).toBeNull();
  });

  it('AC-1 ignores later revisions that stay In Progress', () => {
    const result = computeLastEnterInProgressToDone([
      rev('New', '2024-01-01T00:00:00Z', 1),
      rev('In Progress', '2024-01-05T00:00:00Z', 2),
      rev('In Progress', '2024-01-06T00:00:00Z', 3),
      rev('In Progress', '2024-01-07T00:00:00Z', 4),
      rev('Done', '2024-01-10T00:00:00Z', 5),
    ]);

    expect(result.lastInProgressAt).toBe('2024-01-05T00:00:00.000Z');
    expect(result.cycleTimeDays).toBe(5);
  });

  it('AC-2 treats Closed as a complete end state', () => {
    const result = computeLastEnterInProgressToDone([
      rev('New', '2024-01-01T00:00:00Z', 1),
      rev('In Progress', '2024-01-02T00:00:00Z', 2),
      rev('Closed', '2024-01-06T12:00:00Z', 3),
    ]);

    expect(result.lastDoneAt).toBe('2024-01-06T12:00:00.000Z');
    expect(result.cycleTimeDays).toBe(4.5);
    expect(result.incompleteReason).toBeNull();
  });

  it('AC-3 reopen after Done with no later Done is incomplete', () => {
    const result = computeLastEnterInProgressToDone([
      rev('New', '2024-01-01T00:00:00Z', 1),
      rev('In Progress', '2024-01-02T00:00:00Z', 2),
      rev('Done', '2024-01-05T00:00:00Z', 3),
      rev('In Progress', '2024-01-08T00:00:00Z', 4),
    ]);

    expect(result.lastInProgressAt).toBe('2024-01-08T00:00:00.000Z');
    expect(result.lastDoneAt).toBe('2024-01-05T00:00:00.000Z');
    expect(result.cycleTimeDays).toBeNull();
    expect(result.incompleteReason).toBe('end_not_after_start');
  });

  it('AC-4 reopen then Done again uses the later pair', () => {
    const result = computeLastEnterInProgressToDone([
      rev('In Progress', '2024-01-02T00:00:00Z', 1),
      rev('Done', '2024-01-05T00:00:00Z', 2),
      rev('In Progress', '2024-01-08T00:00:00Z', 3),
      rev('Done', '2024-01-11T00:00:00Z', 4),
    ]);

    expect(result.lastInProgressAt).toBe('2024-01-08T00:00:00.000Z');
    expect(result.lastDoneAt).toBe('2024-01-11T00:00:00.000Z');
    expect(result.cycleTimeDays).toBe(3);
  });

  it('AC-5 missing Done is incomplete', () => {
    const result = computeLastEnterInProgressToDone([
      rev('New', '2024-01-01T00:00:00Z', 1),
      rev('In Progress', '2024-01-02T00:00:00Z', 2),
    ]);

    expect(result.cycleTimeDays).toBeNull();
    expect(result.incompleteReason).toBe('missing_done');
  });

  it('DoD-0 rounds calendar days to one decimal', () => {
    const result = computeLastEnterInProgressToDone([
      rev('In Progress', '2024-01-01T00:00:00Z', 1),
      rev('Done', '2024-01-01T06:00:00Z', 2),
    ]);

    expect(result.cycleTimeDays).toBe(0.3);
  });
});

describe('summarizeRelatedItemCycleTimes', () => {
  const item = (
    id: number,
    days: number | null,
    reason: RelatedItemCycleTime['incompleteReason'] = null,
  ): RelatedItemCycleTime => ({
    id,
    title: `WI ${id}`,
    workItemType: 'PBI',
    state: days == null ? 'In Progress' : 'Done',
    lastInProgressAt: '2024-01-01T00:00:00.000Z',
    lastDoneAt: days == null ? null : '2024-01-05T00:00:00.000Z',
    cycleTimeDays: days,
    incompleteReason: reason,
    workItem: {
      id,
      title: `WI ${id}`,
      state: days == null ? 'In Progress' : 'Done',
      workItemType: 'PBI',
      changedDate: '2024-01-05T00:00:00.000Z',
      createdDate: '2024-01-01T00:00:00.000Z',
      areaPath: 'TestProject\\Area',
      iterationPath: 'TestProject\\Sprint 1',
    },
  });

  it('DoD-1 median and incomplete count exclude incomplete items', () => {
    const summary = summarizeRelatedItemCycleTimes([
      {
        ...item(1, 1),
        lastInProgressAt: '2024-01-01T00:00:00.000Z',
        lastDoneAt: '2024-01-02T00:00:00.000Z',
      },
      {
        ...item(2, 3),
        lastInProgressAt: '2024-01-01T00:00:00.000Z',
        lastDoneAt: '2024-01-04T00:00:00.000Z',
      },
      item(3, null, 'missing_done'),
    ]);

    expect(summary.medianDays).toBe(2);
    expect(summary.sampleSize).toBe(2);
    expect(summary.incompleteCount).toBe(1);
    expect(summary.avgDays).toBe(2);
  });
});
