import {
  formatPlaybookSchedule,
  isDailyPlaybookScheduleDue,
  playbookScheduleDraftFromForm,
  playbookScheduleSchema,
} from '../playbookSchedule';

describe('playbook schedule', () => {
  it('accepts a daily trigger', () => {
    expect(playbookScheduleSchema.parse({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 15,
    })).toMatchObject({ scheduleHour: 2, scheduleMinute: 15 });
  });

  it('drops the hour when the trigger is run now only', () => {
    const draft = playbookScheduleDraftFromForm({
      scheduleKind: 'manual',
      scheduleHour: 2,
      scheduleMinute: 15,
    });
    expect(draft.scheduleHour).toBeNull();
    expect(draft.scheduleMinute).toBe(0);
  });

  it('requires an hour for a daily trigger', () => {
    expect(playbookScheduleSchema.safeParse({
      scheduleKind: 'daily',
      scheduleHour: null,
      scheduleMinute: 0,
    }).success).toBe(false);
  });
});

describe('isDailyPlaybookScheduleDue', () => {
  const now = new Date('2026-10-23T02:05:00.000Z');

  it('is due inside the 15 minute window when it has not started today', () => {
    expect(isDailyPlaybookScheduleDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastScheduledAt: '2026-10-22T02:01:00.000Z',
      now,
    })).toBe(true);
  });

  it('waits until the next day after the window', () => {
    expect(isDailyPlaybookScheduleDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastScheduledAt: null,
      now: new Date('2026-10-23T02:16:00.000Z'),
    })).toBe(false);
  });

  it('does not start twice in the same window', () => {
    expect(isDailyPlaybookScheduleDue({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 0,
      lastScheduledAt: '2026-10-23T02:00:30.000Z',
      now,
    })).toBe(false);
  });

  it('stays due just after UTC midnight when the minute is late', () => {
    expect(isDailyPlaybookScheduleDue({
      scheduleKind: 'daily',
      scheduleHour: 23,
      scheduleMinute: 55,
      lastScheduledAt: null,
      now: new Date('2026-10-24T00:02:00.000Z'),
    })).toBe(true);
  });

  it('ignores a run-now trigger', () => {
    expect(isDailyPlaybookScheduleDue({
      scheduleKind: 'manual',
      scheduleHour: null,
      scheduleMinute: 0,
      lastScheduledAt: null,
      now,
    })).toBe(false);
  });
});

describe('formatPlaybookSchedule', () => {
  it('names the UTC minute', () => {
    expect(formatPlaybookSchedule({
      scheduleKind: 'daily',
      scheduleHour: 2,
      scheduleMinute: 5,
    })).toBe('Daily at 02:05 UTC');
    expect(formatPlaybookSchedule({
      scheduleKind: 'manual',
      scheduleHour: null,
      scheduleMinute: 0,
    })).toBe('Run now only');
  });
});
