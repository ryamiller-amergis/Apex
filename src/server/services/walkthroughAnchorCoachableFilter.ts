/**
 * Coachable-anchor filters for Sync discovery.
 * Prefer product-facing interactive surfaces; drop Platform Admin / walkthrough
 * chrome and nitty-gritty control IDs (leave those to Playwright/unit tests).
 */

const EXCLUDED_PATH_RE =
  /(?:^|\/)(?:PlatformAdmin|WalkthroughsAdminPanel|WalkthroughCatalog|WalkthroughAnchorManagement|WalkthroughAnchorSyncReviewModal|ManualWalkthroughEditor|WalkthroughReporting|FeatureFlagDemo)(?:\.|[A-Z]|$)|(?:^|\/)hooks\/useWalkthrough|\/platform-admin\//i;

/** Admin / walkthrough chrome and fine-grained test-only control IDs. */
const EXCLUDED_TEST_ID_RE =
  /^(?:walkthrough-anchor-|walkthroughs-admin-|platform-admin-)|(?:^|-)(?:enrichment|sync-select|sync-confidence|checkbox|radio|spinner|skeleton|tooltip|pagination|page-\d+|icon-only|delete-confirm)(?:-|$)|\$\{|`/;

/** Tokens that suggest a coachable, user-facing surface. */
const COACHABLE_TOKEN_RE =
  /\b(?:menu|nav|tab|section|panel|sidebar|header|footer|toolbar|filter|search|input|field|form|grid|table|list|modal|dialog|drawer|fab|composer|avatar|bell|notification|button|trigger|empty|banner|page|view|home|profile|standup|calendar|backlog|chat|ask-apex|whats-new|user-menu|create|save|submit|error|success|warning|ado|settings|draft|confirm)\b/i;

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
 * Explicit markers (`anchorTestIdProps`) are always coachable when path/id pass excludes.
 * Plain data-testid must look like a teachable surface (menu/section/input/grid/…).
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
  if (input.sourceKind === 'explicit') return true;
  return COACHABLE_TOKEN_RE.test(input.testId.replace(/-/g, ' '));
}
