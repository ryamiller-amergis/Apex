import {
  buildUpdatePageGenerateHelperText,
  collectUpdatePageScreenshotGaps,
  splitTargetRoutes,
} from '../../shared/utils/updatePageScreenshotGaps';

describe('splitTargetRoutes', () => {
  it('returns an empty list when the route is missing', () => {
    expect(splitTargetRoutes(undefined)).toEqual([]);
    expect(splitTargetRoutes(null)).toEqual([]);
    expect(splitTargetRoutes('')).toEqual([]);
  });

  it('splits and trims comma-separated routes', () => {
    expect(splitTargetRoutes(' /Timecard/Entry , /Timecard/Edit ')).toEqual([
      '/Timecard/Entry',
      '/Timecard/Edit',
    ]);
  });
});

describe('collectUpdatePageScreenshotGaps', () => {
  const updateFeature = {
    featureIndex: 0,
    featureName: 'Hours Entry',
    decision: 'update-page' as const,
    targetRoute: '/Timecard/Entry',
  };

  it('ignores new-page and no-ui features', () => {
    const { gaps, isChecking } = collectUpdatePageScreenshotGaps(
      [
        { featureIndex: 0, featureName: 'New', decision: 'new-page' },
        { featureIndex: 1, featureName: 'Backend', decision: 'no-ui' },
      ],
      () => false,
    );
    expect(gaps).toEqual([]);
    expect(isChecking).toBe(false);
  });

  it('flags update-page features with no target route', () => {
    const { gaps } = collectUpdatePageScreenshotGaps(
      [{ ...updateFeature, targetRoute: undefined }],
      () => true,
    );
    expect(gaps).toEqual([
      { featureIndex: 0, featureName: 'Hours Entry', reason: 'missing-route' },
    ]);
  });

  it('flags update-page features whose screenshot is not on file', () => {
    const { gaps } = collectUpdatePageScreenshotGaps(
      [updateFeature],
      () => false,
    );
    expect(gaps).toEqual([
      {
        featureIndex: 0,
        featureName: 'Hours Entry',
        reason: 'missing-screenshot',
        route: '/timecard/entry',
      },
    ]);
  });

  it('treats an in-flight lookup as checking, not a gap', () => {
    const { gaps, isChecking } = collectUpdatePageScreenshotGaps(
      [updateFeature],
      () => undefined,
    );
    expect(gaps).toEqual([]);
    expect(isChecking).toBe(true);
  });

  it('returns no gaps when the screenshot is on file', () => {
    const { gaps, isChecking } = collectUpdatePageScreenshotGaps(
      [updateFeature],
      () => true,
    );
    expect(gaps).toEqual([]);
    expect(isChecking).toBe(false);
  });
});

describe('buildUpdatePageGenerateHelperText', () => {
  it('returns null when nothing is missing', () => {
    expect(buildUpdatePageGenerateHelperText([], false)).toBeNull();
  });

  it('explains a screenshot check in progress', () => {
    expect(buildUpdatePageGenerateHelperText([], true)).toBe(
      'Checking for existing page screenshots…',
    );
  });

  it('lists features that still need a screenshot', () => {
    expect(
      buildUpdatePageGenerateHelperText(
        [{ featureIndex: 0, featureName: 'Hours Entry', reason: 'missing-screenshot', route: '/timecard/entry' }],
        false,
      ),
    ).toContain('Hours Entry');
  });
});
