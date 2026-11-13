import {
  computeCompletionPercent,
  computeExpandedPlatformSummaries,
  computeLifecycleCounts,
  computeSlatedReleasesOverview,
  filterExpandedWorkItems,
  filterReleaseEpics,
  getWorkItemValidationBucket,
  groupExpandedWorkItems,
  groupReleaseEpics,
  type ReleaseEpicRecord,
} from '../releaseOrganization';
import type { ReleasePlatform } from '../../../shared/types/releasePlatforms';
import type { WorkItem } from '../../types/workitem';

const DESKTOP: ReleasePlatform = {
  id: 'plat-desktop',
  project: 'MaxView',
  slug: 'desktop',
  name: 'Desktop',
  color: 'blue',
  sortOrder: 0,
  createdAt: '2026-11-13T00:00:00.000Z',
};

const MOBILE: ReleasePlatform = {
  id: 'plat-mobile',
  project: 'MaxView',
  slug: 'mobile',
  name: 'Mobile',
  color: 'purple',
  sortOrder: 1,
  createdAt: '2026-11-13T00:01:00.000Z',
};

function makeWorkItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title' | 'state'>): WorkItem {
  return {
    workItemType: 'Product Backlog Item',
    changedDate: '2026-11-01',
    createdDate: '2026-10-01',
    areaPath: 'MaxView',
    iterationPath: 'MaxView\\Sprint 1',
    tags: '',
    ...overrides,
  };
}

const SAMPLE_EPICS: ReleaseEpicRecord[] = [
  {
    id: 101,
    version: 'v2.4 Desktop & Mobile',
    status: 'In Progress',
    targetDate: '2026-11-20',
    description: 'Core cross-platform release',
    totalItems: 4,
    completedItems: 2,
    greenItems: 2,
    amberItems: 1,
    redItems: 1,
    progress: 50,
    childItemsSummary: [
      { id: 1, state: 'Ready For Release', tags: 'Desktop' },
      { id: 2, state: 'Done', tags: 'Desktop; Mobile' },
      { id: 3, state: 'UAT - Ready For Test', tags: 'Mobile' },
      { id: 4, state: 'In Progress', tags: 'Desktop' },
    ],
  },
  {
    id: 102,
    version: 'v2.5 Upcoming',
    status: 'New',
    targetDate: '2026-11-05', // past due relative to 2026-11-13 with remaining items
    description: 'Mobile offline sync',
    totalItems: 2,
    completedItems: 0,
    greenItems: 0,
    amberItems: 1,
    redItems: 1,
    progress: 0,
    childItemsSummary: [
      { id: 5, state: 'UAT Ready For Test', tags: 'Mobile' },
      { id: 6, state: 'Committed', tags: 'Mobile' },
    ],
  },
  {
    id: 103,
    version: 'v2.3 Shipped',
    status: 'Done',
    targetDate: '2026-10-15',
    description: 'Previous production release',
    totalItems: 5,
    completedItems: 5,
    greenItems: 5,
    amberItems: 0,
    redItems: 0,
    progress: 100,
    childItemsSummary: [],
  },
];

describe('releaseOrganization — validation buckets & unchanged completion %', () => {
  it('classifies Green, Amber, and Red states using the exact release rules', () => {
    expect(getWorkItemValidationBucket('Ready For Release')).toBe('green');
    expect(getWorkItemValidationBucket('UAT - Test Done')).toBe('green');
    expect(getWorkItemValidationBucket('Done')).toBe('green');
    expect(getWorkItemValidationBucket('Closed')).toBe('green');

    expect(getWorkItemValidationBucket('UAT - Ready For Test')).toBe('amber');
    expect(getWorkItemValidationBucket('UAT Ready For Test')).toBe('amber');
    expect(getWorkItemValidationBucket('UAT-Ready For Test')).toBe('amber');

    expect(getWorkItemValidationBucket('New')).toBe('red');
    expect(getWorkItemValidationBucket('In Progress')).toBe('red');
    expect(getWorkItemValidationBucket('In Pull Request')).toBe('red');
  });

  it('preserves Math.round((greenItems / totalItems) * 100) completion formula', () => {
    expect(computeCompletionPercent(0, 0)).toBe(0);
    expect(computeCompletionPercent(1, 3)).toBe(33);
    expect(computeCompletionPercent(2, 3)).toBe(67);
    expect(computeCompletionPercent(3, 3)).toBe(100);
  });
});

describe('releaseOrganization — slated overview & platform readiness matrix', () => {
  it('excludes shipped releases (Done/Closed/Removed) from slated overview metrics', () => {
    const overview = computeSlatedReleasesOverview({
      epics: SAMPLE_EPICS,
      platforms: [DESKTOP, MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
      todayIsoDate: '2026-11-13',
    });

    // Only epics 101 and 102 are slated (103 is Done)
    expect(overview.slatedReleaseCount).toBe(2);
    expect(overview.totalItems).toBe(6);
    expect(overview.greenItems).toBe(2);
    expect(overview.amberItems).toBe(2);
    expect(overview.redItems).toBe(2);
    expect(overview.leftToValidate).toBe(4);
    expect(overview.completionPercent).toBe(33); // Math.round(2/6 * 100)
    expect(overview.overdueCount).toBe(1); // epic 102 targetDate 2026-11-05 < 2026-11-13
    expect(overview.nearestTargetDate).toBe('2026-11-20');
    expect(overview.nearestReleaseVersion).toBe('v2.4 Desktop & Mobile');

    // Platform readiness breakdown:
    // Desktop items across slated releases: #1 (green), #2 (green), #4 (red) => 2/3 = 67%, 1 left
    const desktopSummary = overview.platformReadiness.find((p) => p.platform.slug === 'desktop')!;
    expect(desktopSummary.slatedReleaseCount).toBe(1);
    expect(desktopSummary.totalItems).toBe(3);
    expect(desktopSummary.greenItems).toBe(2);
    expect(desktopSummary.leftToValidate).toBe(1);
    expect(desktopSummary.completionPercent).toBe(67);

    // Mobile items across slated releases: #2 (green), #3 (amber), #5 (amber), #6 (red) => 1/4 = 25%, 3 left
    const mobileSummary = overview.platformReadiness.find((p) => p.platform.slug === 'mobile')!;
    expect(mobileSummary.slatedReleaseCount).toBe(2);
    expect(mobileSummary.totalItems).toBe(4);
    expect(mobileSummary.greenItems).toBe(1);
    expect(mobileSummary.amberItems).toBe(2);
    expect(mobileSummary.redItems).toBe(1);
    expect(mobileSummary.leftToValidate).toBe(3);
    expect(mobileSummary.completionPercent).toBe(25);
  });

  it('returns empty platformReadiness when project has 0 platforms configured', () => {
    const overview = computeSlatedReleasesOverview({
      epics: SAMPLE_EPICS,
      platforms: [],
      epicPlatformIds: {},
      workItemPlatformIds: {},
      todayIsoDate: '2026-11-13',
    });
    expect(overview.platformReadiness).toEqual([]);
    expect(overview.slatedReleaseCount).toBe(2);
  });
});

describe('releaseOrganization — lifecycle & platform filtering and grouping', () => {
  it('computes accurate lifecycle pill counts', () => {
    expect(computeLifecycleCounts(SAMPLE_EPICS)).toEqual({
      all: 3,
      slated: 2,
      'in-flight': 1,
      planned: 1,
      shipped: 1,
    });
  });

  it('filters releases by lifecycle, platform slug, and search text', () => {
    const slatedMobile = filterReleaseEpics({
      epics: SAMPLE_EPICS,
      lifecycleFilter: 'slated',
      platformFilterSlug: 'mobile',
      searchText: 'offline',
      platforms: [DESKTOP, MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });
    expect(slatedMobile.map((e) => e.id)).toEqual([102]);
  });

  it('groups releases by Lifecycle Stage and Target Platform', () => {
    const byLifecycle = groupReleaseEpics({
      epics: SAMPLE_EPICS,
      groupBy: 'lifecycle',
      platforms: [DESKTOP, MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });
    expect(byLifecycle.map((s) => s.key)).toEqual(['in-flight', 'planned', 'shipped']);
    expect(byLifecycle[0].leftToValidate).toBe(2);

    const byPlatform = groupReleaseEpics({
      epics: SAMPLE_EPICS,
      groupBy: 'platform',
      platforms: [DESKTOP, MOBILE],
      epicPlatformIds: {},
      workItemPlatformIds: {},
    });
    expect(byPlatform.map((s) => s.key)).toEqual(['desktop', 'mobile', 'unassigned']);
    expect(byPlatform.find((s) => s.key === 'desktop')!.epics.map((e) => e.id)).toEqual([101]);
    expect(byPlatform.find((s) => s.key === 'mobile')!.epics.map((e) => e.id)).toEqual([101, 102]);
    expect(byPlatform.find((s) => s.key === 'unassigned')!.epics.map((e) => e.id)).toEqual([103]);
  });
});

describe('releaseOrganization — expanded work item filtering & grouping', () => {
  const items: WorkItem[] = [
    makeWorkItem({ id: 1, title: 'Desktop Installer', state: 'Ready For Release', workItemType: 'Feature', tags: 'Desktop' }),
    makeWorkItem({ id: 2, title: 'Push Notifications', state: 'UAT - Ready For Test', workItemType: 'Product Backlog Item', tags: 'Mobile' }),
    makeWorkItem({ id: 3, title: 'Crash on Resume', state: 'In Progress', workItemType: 'Bug', tags: '' }),
  ];

  it('filters expanded items by validation bucket and platform', () => {
    const leftToValidate = filterExpandedWorkItems({
      items,
      bucketFilter: 'left-to-validate',
      platformSlugFilter: null,
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: { 3: ['plat-mobile'] },
    });
    expect(leftToValidate.map((i) => i.id)).toEqual([2, 3]);

    const uatReady = filterExpandedWorkItems({
      items,
      bucketFilter: 'uat-ready',
      platformSlugFilter: 'mobile',
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: {},
    });
    expect(uatReady.map((i) => i.id)).toEqual([2]);
  });

  it('groups expanded items by Validation Status, Platform, and Work Item Type', () => {
    const byValidation = groupExpandedWorkItems({
      items,
      groupBy: 'validation',
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: {},
    });
    expect(byValidation.map((s) => s.key)).toEqual(['amber', 'red', 'green']);
    expect(byValidation[0].items.map((i) => i.id)).toEqual([2]);

    const byPlatform = groupExpandedWorkItems({
      items,
      groupBy: 'platform',
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: {},
    });
    expect(byPlatform.map((s) => s.key)).toEqual(['desktop', 'mobile', 'unassigned']);

    const byType = groupExpandedWorkItems({
      items,
      groupBy: 'type',
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: {},
    });
    expect(byType.map((s) => s.key)).toEqual(['features', 'backlog-items', 'bugs-other']);

    const summaries = computeExpandedPlatformSummaries({
      items,
      platforms: [DESKTOP, MOBILE],
      workItemPlatformIds: { 3: ['plat-mobile'] },
    });
    expect(summaries[0]).toMatchObject({ greenItems: 1, totalItems: 1, leftToValidate: 0 });
    expect(summaries[1]).toMatchObject({ greenItems: 0, totalItems: 2, leftToValidate: 2 });
  });
});
