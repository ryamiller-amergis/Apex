/**
 * Coachable-anchor filters for Sync discovery.
 * Drop Platform Admin / walkthrough chrome and known fine-grained test-only IDs.
 * Do not require positive “coachable token” allowlists — any non-excluded
 * data-testid / explicit marker is eligible for catalog review.
 */

const EXCLUDED_PATH_RE =
  /(?:^|\/)(?:PlatformAdmin|WalkthroughsAdminPanel|WalkthroughCatalog|WalkthroughAnchorManagement|WalkthroughAnchorSyncReviewModal|ManualWalkthroughEditor|WalkthroughReporting|FeatureFlagDemo)(?:\.|[A-Z]|$)|(?:^|\/)hooks\/useWalkthrough|\/platform-admin\//i;

/** Admin / walkthrough chrome and fine-grained test-only control IDs. */
const EXCLUDED_TEST_ID_RE =
  /^(?:walkthrough-anchor-|walkthroughs-admin-|platform-admin-)|(?:^|-)(?:enrichment|sync-select|sync-confidence|checkbox|radio|spinner|skeleton|tooltip|pagination|page-\d+|icon-only|delete-confirm)(?:-|$)|\$\{|`/;

export function isExcludedWalkthroughScanPath(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, '/');
  return EXCLUDED_PATH_RE.test(posix);
}

export function isExcludedWalkthroughTestId(testId: string): boolean {
  const id = testId.trim();
  if (!id) return true;
  return EXCLUDED_TEST_ID_RE.test(id);
}

/**
 * True when a discovery should enter Sync review / stay in coachable queues.
 * Excludes admin chrome paths and nitty test-only IDs only.
 */
export function isCoachableWalkthroughDiscovery(input: {
  testId: string;
  sourceKind: 'explicit' | 'data_testid';
  sourceLocations: ReadonlyArray<{ filePath: string }>;
}): boolean {
  if (isExcludedWalkthroughTestId(input.testId)) return false;
  if (
    input.sourceLocations.some((loc) =>
      isExcludedWalkthroughScanPath(loc.filePath)
    )
  ) {
    return false;
  }
  return true;
}
