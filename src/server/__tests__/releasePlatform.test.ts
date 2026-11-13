import { deriveReleasePlatform, isAreaPathInProject } from '../../shared/utils/releasePlatform';

describe('deriveReleasePlatform', () => {
  it('returns Mobile when the leaf segment contains mobile (case-insensitive)', () => {
    expect(deriveReleasePlatform('MaxView\\Mobile')).toBe('Mobile');
    expect(deriveReleasePlatform('MaxView\\Teams\\mobile-app')).toBe('Mobile');
    expect(deriveReleasePlatform('Mobile')).toBe('Mobile');
  });

  it('returns Desktop when the leaf segment contains desktop (case-insensitive)', () => {
    expect(deriveReleasePlatform('MaxView\\Desktop')).toBe('Desktop');
    expect(deriveReleasePlatform('MaxView\\Apps\\DesktopClient')).toBe('Desktop');
    expect(deriveReleasePlatform('desktop')).toBe('Desktop');
  });

  it('checks only the leaf segment, not parent segments', () => {
    expect(deriveReleasePlatform('MobileOrg\\Desktop')).toBe('Desktop');
    expect(deriveReleasePlatform('MaxView\\Mobile\\WebPortal')).toBe('WebPortal');
  });

  it('falls back to the leaf segment when neither mobile nor desktop matches', () => {
    expect(deriveReleasePlatform('MaxView\\Platform')).toBe('Platform');
    expect(deriveReleasePlatform('MaxView')).toBe('MaxView');
  });

  it('falls back to fallbackProject or General when areaPath is empty', () => {
    expect(deriveReleasePlatform('', 'MaxView')).toBe('MaxView');
    expect(deriveReleasePlatform(undefined, 'MaxView')).toBe('MaxView');
    expect(deriveReleasePlatform('', '')).toBe('General');
    expect(deriveReleasePlatform(undefined, undefined)).toBe('General');
  });
});

describe('isAreaPathInProject', () => {
  it('accepts the project root and sub-paths case-insensitively', () => {
    expect(isAreaPathInProject('MaxView', 'MaxView')).toBe(true);
    expect(isAreaPathInProject('MaxView\\Mobile', 'MaxView')).toBe(true);
    expect(isAreaPathInProject('maxview\\desktop', 'MaxView')).toBe(true);
  });

  it('rejects area paths belonging to another project or partial prefix', () => {
    expect(isAreaPathInProject('OtherProject\\Mobile', 'MaxView')).toBe(false);
    expect(isAreaPathInProject('MaxViewTwo\\Mobile', 'MaxView')).toBe(false);
    expect(isAreaPathInProject('', 'MaxView')).toBe(false);
  });
});
