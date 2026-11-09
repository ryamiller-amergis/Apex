import {
  resolveBackgroundJobsMode,
  runsSharedBackgroundJobs,
} from '../services/backgroundJobsMode';

describe('resolveBackgroundJobsMode', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test.each([undefined, '', '   '])('defaults to full when the setting is %p', (raw) => {
    expect(resolveBackgroundJobsMode(raw)).toBe('full');
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ['full', 'full'],
    ['off', 'off'],
    [' OFF ', 'off'],
    ['Full', 'full'],
  ] as const)('parses %p as %p', (raw, expected) => {
    expect(resolveBackgroundJobsMode(raw)).toBe(expected);
    expect(warn).not.toHaveBeenCalled();
  });

  test('warns and falls back to full on an unknown value', () => {
    expect(resolveBackgroundJobsMode('disabled')).toBe('full');
    expect(warn).toHaveBeenCalledWith(
      '[background-jobs] unknown BACKGROUND_JOBS_MODE="disabled"; using full',
    );
  });
});

describe('runsSharedBackgroundJobs', () => {
  test('full starts the shared background loops', () => {
    expect(runsSharedBackgroundJobs('full')).toBe(true);
  });

  test('off skips the shared background loops', () => {
    expect(runsSharedBackgroundJobs('off')).toBe(false);
  });
});
