import { semverCompare, semverGt, semverValid } from '../../shared/utils/semverStrict';

describe('semverStrict (DoD-2 / VT-01–VT-03)', () => {
  it('semverValid accepts strict SemVer and rejects malformed values', () => {
    expect(semverValid('1.4.3')).toBe('1.4.3');
    expect(semverValid('1.0.0-alpha.1')).toBe('1.0.0-alpha.1');
    expect(semverValid('1.0.0+build.1')).toBe('1.0.0+build.1');
    expect(semverValid('1.4')).toBeNull();
    expect(semverValid('v1.4.3')).toBeNull();
    expect(semverValid('not-a-version')).toBeNull();
    expect(semverValid('')).toBeNull();
    expect(semverValid(null)).toBeNull();
  });

  it('semverGt drives unread when current is strictly greater (patch included)', () => {
    expect(semverGt('1.4.3', '1.4.2')).toBe(true);
    expect(semverGt('1.0.1', '1.0.0')).toBe(true);
    expect(semverGt('1.4.3', '1.4.3')).toBe(false);
    expect(semverGt('1.4.2', '1.4.3')).toBe(false);
    expect(semverGt('1.5.0', '1.4.3')).toBe(true);
  });

  it('semverGt fails safe when either side is malformed', () => {
    expect(semverGt('1.4.3', 'bad')).toBe(false);
    expect(semverGt('bad', '1.4.2')).toBe(false);
  });

  it('semverCompare orders prerelease below the corresponding release', () => {
    expect(semverCompare('1.0.0', '1.0.0-alpha')).toBeGreaterThan(0);
    expect(semverCompare('1.0.0-alpha.1', '1.0.0-alpha')).toBeGreaterThan(0);
  });
});
