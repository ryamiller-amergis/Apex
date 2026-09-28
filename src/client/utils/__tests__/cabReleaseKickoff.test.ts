import {
  buildCabReleaseKickoffMessage,
  defaultPreviousReleaseBranch,
  normalizeReleaseBranch,
} from '../cabReleaseKickoff';

describe('normalizeReleaseBranch', () => {
  it('prefixes a bare version', () => {
    expect(normalizeReleaseBranch('2026.12.0')).toBe('Release/2026.12.0');
  });

  it('keeps an existing Release/ prefix', () => {
    expect(normalizeReleaseBranch('Release/2026.11.0.1')).toBe('Release/2026.11.0.1');
  });

  it('returns empty for blank input', () => {
    expect(normalizeReleaseBranch('  ')).toBe('');
  });
});

describe('defaultPreviousReleaseBranch', () => {
  it('uses the version immediately before the target when versions are ordered', () => {
    expect(
      defaultPreviousReleaseBranch(['2026.11.0.1', '2026.12.0', '2026.13.0'], '2026.13.0'),
    ).toBe('Release/2026.12.0');
  });

  it('returns empty when the target is the only version', () => {
    expect(defaultPreviousReleaseBranch(['2026.13.0'], '2026.13.0')).toBe('');
  });
});

describe('buildCabReleaseKickoffMessage', () => {
  it('includes epic id, related ids, dry-run, and no branch cut', () => {
    const text = buildCabReleaseKickoffMessage({
      targetVersion: '2026.13.0',
      apexReleaseEpicId: 12345,
      relatedWorkItemIds: [53247, 53249],
      previousReleaseBranch: 'Release/2026.12.0',
      snowMode: 'dry-run',
      cutReleaseBranch: false,
    });

    expect(text).toContain('Target version: 2026.13.0');
    expect(text).toContain('Apex Release Epic id: 12345');
    expect(text).toContain('Apex Related work item IDs: 53247,53249');
    expect(text).toContain('Dry-run');
    expect(text).toContain('do not create or push the git branch');
    expect(text).toContain('Print skill script stdout');
  });

  it('tells the skill not to invent a development fallback when related ids are empty', () => {
    const text = buildCabReleaseKickoffMessage({
      targetVersion: '2026.13.0',
      apexReleaseEpicId: 99,
      relatedWorkItemIds: [],
      previousReleaseBranch: 'Release/2026.12.0',
      snowMode: 'run',
      cutReleaseBranch: true,
    });

    expect(text).toContain('do not invent a development prod-cd fallback');
    expect(text).toContain('Run (queue definition 595');
    expect(text).toContain('create and push Release/{version} from current development');
  });
});
