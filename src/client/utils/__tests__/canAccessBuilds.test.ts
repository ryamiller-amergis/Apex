import { canAccessBuilds } from '../canAccessBuilds';

const canView = (key: string) => key === 'builds:view';
const canNothing = () => false;

describe('canAccessBuilds (PBI-003)', () => {
  it.each([
    // flag, superAdmin, menu, can, expected
    [true, false, ['builds'], canView, true],
    [false, false, ['builds'], canView, false],
    [true, false, [], canView, false],
    [true, false, ['builds'], canNothing, false],
    [true, true, [], canNothing, true],
    [false, true, ['builds'], canView, false],
  ])('flag=%s superAdmin=%s menu=%j → %s', (flagEnabled, isSuperAdmin, enabledViews, can, expected) => {
    expect(canAccessBuilds({ flagEnabled, isSuperAdmin, enabledViews, can })).toBe(expected);
  });
});
