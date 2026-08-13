import {
  formatGitProgressLabel,
  mapGitProgressToOverall,
  parseGitProgressChunk,
  parseGitProgressLine,
} from '../utils/gitCheckoutProgress';

describe('gitCheckoutProgress DoD-0/1 — parse git --progress into throttled DTO windows', () => {
  it('DoD-0: parses Receiving objects / Resolving deltas / Checking out files percents', () => {
    expect(parseGitProgressLine('Receiving objects: 45% (1234/2742)')).toEqual({
      phase: 'receiving-objects',
      gitPercent: 45,
    });
    expect(parseGitProgressLine('Resolving deltas: 12% (10/80)')).toEqual({
      phase: 'resolving-deltas',
      gitPercent: 12,
    });
    expect(parseGitProgressLine('Checking out files: 80% (800/1000)')).toEqual({
      phase: 'checking-out',
      gitPercent: 80,
    });
    expect(parseGitProgressLine('unrelated stderr')).toBeNull();
  });

  it('DoD-1: maps phases into 10–60 (mirror) and 60–95 (materialize) without jumping backward', () => {
    expect(mapGitProgressToOverall('queued', 0)).toBe(0);
    expect(mapGitProgressToOverall('starting', 100)).toBe(10);
    expect(mapGitProgressToOverall('receiving-objects', 0)).toBe(10);
    expect(mapGitProgressToOverall('receiving-objects', 100)).toBe(45);
    expect(mapGitProgressToOverall('resolving-deltas', 0)).toBe(45);
    expect(mapGitProgressToOverall('resolving-deltas', 100)).toBe(60);
    expect(mapGitProgressToOverall('checking-out', 0)).toBe(60);
    expect(mapGitProgressToOverall('checking-out', 100)).toBe(95);
    expect(mapGitProgressToOverall('ready', 100)).toBe(100);

    expect(mapGitProgressToOverall('resolving-deltas', 0, 44)).toBe(45);
    expect(mapGitProgressToOverall('receiving-objects', 0, 40)).toBe(40);
  });

  it('DoD-0: formats a stable last-known-phase label', () => {
    expect(formatGitProgressLabel('receiving-objects', 45)).toBe('Receiving objects 45%');
    expect(formatGitProgressLabel('queued')).toBe('Queued');
  });

  it('DoD-1: chunk parser keeps the highest mapped percent across a CR-rewritten git line', () => {
    const first = parseGitProgressChunk('Receiving objects: 45% (1234/2742)\r');
    expect(first?.percent).toBe(mapGitProgressToOverall('receiving-objects', 45));
    const second = parseGitProgressChunk(
      'Receiving objects: 100% (2742/2742)\rResolving deltas: 0% (0/80)\r',
      first?.percent ?? null,
    );
    expect(second?.percent).toBeGreaterThanOrEqual(first!.percent);
    expect(second?.label).toMatch(/Resolving deltas|Receiving objects/);
  });
});
