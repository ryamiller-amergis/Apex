/** Tabs of the Build Run View, in display order. Epic 2 inserts `verification` and `preview`. */
export const BUILD_RUN_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'plan', label: 'Plan' },
  { key: 'timeline', label: 'Timeline' },
] as const;

export type BuildRunTabKey = (typeof BUILD_RUN_TABS)[number]['key'];

export function isBuildRunTabKey(value: string): value is BuildRunTabKey {
  return BUILD_RUN_TABS.some((tab) => tab.key === value);
}

/** A bare address shows Overview; an unknown segment redirects there. */
export function resolveBuildRunTab(segment: string | undefined): { tab: BuildRunTabKey; redirect: boolean } {
  if (!segment) return { tab: 'overview', redirect: false };
  if (isBuildRunTabKey(segment)) return { tab: segment, redirect: false };
  return { tab: 'overview', redirect: true };
}
