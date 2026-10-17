import {
  buildCabReleaseKickoffMessage,
  defaultPreviousReleaseBranch,
  normalizeReleaseBranch,
  normalizeReleaseVersion,
} from '../cabReleaseKickoff';

describe('normalizeReleaseVersion', () => {
  it('extracts the numeric version from an Apex label', () => {
    expect(normalizeReleaseVersion('MV 2026.15.0')).toBe('2026.15.0');
  });

  it('returns empty when no numeric release version exists', () => {
    expect(normalizeReleaseVersion('phase three')).toBe('');
  });
});

describe('normalizeReleaseBranch', () => {
  it('prefixes a bare version', () => {
    expect(normalizeReleaseBranch('2026.12.0')).toBe('Release/2026.12.0');
  });

  it('keeps an existing Release/ prefix', () => {
    expect(normalizeReleaseBranch('Release/2026.11.0.1')).toBe('Release/2026.11.0.1');
  });

  it('removes the Apex product label', () => {
    expect(normalizeReleaseBranch('Release/MV 2026.14.0')).toBe('Release/2026.14.0');
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

  it('ignores the table sort and still picks the prior version', () => {
    expect(
      defaultPreviousReleaseBranch(['2026.13.0', '2026.11.0.1', '2026.12.0'], '2026.13.0'),
    ).toBe('Release/2026.12.0');
  });

  it('normalizes Apex release titles before selecting the previous release', () => {
    expect(
      defaultPreviousReleaseBranch(
        ['MV 2026.13.0', 'MV 2026.14.0', 'MV 2026.15.0'],
        'MV 2026.15.0',
      ),
    ).toBe('Release/2026.14.0');
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

  it('passes normalized release refs when Apex titles contain the product label', () => {
    const text = buildCabReleaseKickoffMessage({
      targetVersion: 'MV 2026.15.0',
      apexReleaseEpicId: 57784,
      relatedWorkItemIds: [53378],
      previousReleaseBranch: 'Release/MV 2026.14.0',
      snowMode: 'dry-run',
      cutReleaseBranch: false,
    });

    expect(text).toContain('Target version: 2026.15.0');
    expect(text).toContain('Previous shipped release branch: Release/2026.14.0');
    expect(text).toContain('Cut Release/2026.15.0 from development');
    expect(text).not.toContain('Release/MV');
  });

  it('rejects a target without a numeric release version', () => {
    expect(() => buildCabReleaseKickoffMessage({
      targetVersion: 'MV phase three',
      apexReleaseEpicId: 57784,
      relatedWorkItemIds: [],
      previousReleaseBranch: 'Release/2026.14.0',
      snowMode: 'dry-run',
      cutReleaseBranch: false,
    })).toThrow('Invalid CAB release version');
  });
});
