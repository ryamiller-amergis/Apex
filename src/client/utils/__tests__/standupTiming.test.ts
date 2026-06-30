import {
  formatDurationLabel,
  minuteOptionsForValue,
  parseScheduleTime,
  toScheduleTime,
} from '../standupTiming';

describe('parseScheduleTime', () => {
  it('parses morning times as AM', () => {
    expect(parseScheduleTime('09:00')).toEqual({ hour12: 9, minute: 0, period: 'AM' });
    expect(parseScheduleTime('00:30')).toEqual({ hour12: 12, minute: 30, period: 'AM' });
  });

  it('parses afternoon times as PM', () => {
    expect(parseScheduleTime('13:15')).toEqual({ hour12: 1, minute: 15, period: 'PM' });
    expect(parseScheduleTime('12:00')).toEqual({ hour12: 12, minute: 0, period: 'PM' });
  });
});

describe('toScheduleTime', () => {
  it('round-trips common schedule values', () => {
    expect(toScheduleTime(9, 0, 'AM')).toBe('09:00');
    expect(toScheduleTime(1, 30, 'PM')).toBe('13:30');
    expect(toScheduleTime(12, 0, 'AM')).toBe('00:00');
    expect(toScheduleTime(12, 0, 'PM')).toBe('12:00');
  });
});

describe('formatDurationLabel', () => {
  it('formats sub-hour durations in minutes', () => {
    expect(formatDurationLabel(30)).toBe('30 min');
  });

  it('formats whole hours without minutes', () => {
    expect(formatDurationLabel(120)).toBe('2 hr');
  });

  it('formats mixed hour and minute durations', () => {
    expect(formatDurationLabel(90)).toBe('1 hr 30 min');
  });
});

describe('minuteOptionsForValue', () => {
  it('returns standard five-minute increments when value is aligned', () => {
    expect(minuteOptionsForValue(30)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it('includes a non-standard minute from existing configs', () => {
    expect(minuteOptionsForValue(7)).toContain(7);
    expect(minuteOptionsForValue(7)).toEqual(
      expect.arrayContaining([0, 5, 7, 10, 15]),
    );
  });
});
