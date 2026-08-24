import { normaliseUrlToRoute } from './routeNormalization';

export type UpdatePageScreenshotGapReason = 'missing-route' | 'missing-screenshot';

export interface UpdatePageScreenshotGap {
  featureIndex: number;
  featureName: string;
  reason: UpdatePageScreenshotGapReason;
  route?: string;
}

export function splitTargetRoutes(targetRoute?: string | null): string[] {
  if (!targetRoute) return [];
  return targetRoute.split(',').map((r) => r.trim()).filter(Boolean);
}

/**
 * Returns Update page features that cannot generate yet: no page address,
 * or no screenshot on file for that address.
 *
 * `lookup` should return `true`/`false` when the screenshot status is known,
 * or `undefined` while a lookup is still in flight.
 */
export function collectUpdatePageScreenshotGaps(
  features: Array<{
    featureIndex: number;
    featureName: string;
    decision: string;
    targetRoute?: string | null;
  }>,
  lookup: (route: string) => boolean | undefined,
): { gaps: UpdatePageScreenshotGap[]; isChecking: boolean } {
  const gaps: UpdatePageScreenshotGap[] = [];
  let isChecking = false;

  for (const feature of features) {
    if (feature.decision !== 'update-page') continue;

    const routes = splitTargetRoutes(feature.targetRoute);
    if (routes.length === 0) {
      gaps.push({
        featureIndex: feature.featureIndex,
        featureName: feature.featureName,
        reason: 'missing-route',
      });
      continue;
    }

    for (const raw of routes) {
      const route = normaliseUrlToRoute(raw);
      const status = lookup(route);
      if (status === undefined) {
        isChecking = true;
        continue;
      }
      if (!status) {
        gaps.push({
          featureIndex: feature.featureIndex,
          featureName: feature.featureName,
          reason: 'missing-screenshot',
          route,
        });
      }
    }
  }

  return { gaps, isChecking };
}

export function buildUpdatePageGenerateHelperText(
  gaps: UpdatePageScreenshotGap[],
  isChecking: boolean,
): string | null {
  if (gaps.length === 0) {
    return isChecking ? 'Checking for existing page screenshots…' : null;
  }

  const names = [...new Set(gaps.map((g) => g.featureName))];
  const needsRoute = gaps.some((g) => {
    switch (g.reason) {
      case 'missing-route':
        return true;
      case 'missing-screenshot':
        return false;
      default: {
        const _exhaustive: never = g.reason;
        return _exhaustive;
      }
    }
  });

  const prefix = needsRoute
    ? 'Each Update page feature needs the existing page address and a screenshot before you can generate designs.'
    : 'Upload a screenshot of the existing page for each Update page feature before generating designs.';
  return `${prefix} Still needed: ${names.join(', ')}.`;
}
