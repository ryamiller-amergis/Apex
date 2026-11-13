import type { WorkItem } from '../types/workitem';
import {
  resolveReleaseEpicPlatforms,
  resolveWorkItemPlatforms,
  type ReleasePlatform,
  type ReleasePlatformSummaryChildItem,
} from '../../shared/types/releasePlatforms';

export const GREEN_RELEASE_STATES = [
  'Ready For Release',
  'UAT - Test Done',
  'Done',
  'Closed',
] as const;

export const AMBER_RELEASE_STATES = [
  'UAT - Ready For Test',
  'UAT Ready For Test',
  'UAT-Ready For Test',
] as const;

export const SHIPPED_RELEASE_STATUSES = ['Done', 'Closed', 'Removed'] as const;
export const IN_FLIGHT_RELEASE_STATUSES = ['In Progress', 'Active', 'Committed'] as const;
export const PLANNED_RELEASE_STATUSES = ['New', 'In Design'] as const;

export type ValidationBucket = 'green' | 'amber' | 'red';

export type ReleaseLifecycleFilter =
  | 'all'
  | 'slated'
  | 'in-flight'
  | 'planned'
  | 'shipped';

export type ReleaseGroupBy = 'none' | 'lifecycle' | 'platform';

export type ExpandedItemFilter =
  | 'all'
  | 'left-to-validate'
  | 'uat-ready'
  | 'in-dev'
  | 'validated';

export type ExpandedItemGroupBy = 'none' | 'validation' | 'platform' | 'type';

export interface ReleaseEpicRecord {
  id: number;
  version: string;
  status: string;
  startDate?: string;
  targetDate?: string;
  description?: string;
  tags?: string;
  progress?: number;
  totalItems?: number;
  completedItems?: number;
  greenItems?: number;
  amberItems?: number;
  redItems?: number;
  childItemsSummary?: ReleasePlatformSummaryChildItem[];
}

export interface ReleaseValidationSummary {
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
}

export interface PlatformReadinessSummary {
  platform: ReleasePlatform;
  slatedReleaseCount: number;
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
}

export interface SlatedReleasesOverview {
  slatedReleaseCount: number;
  nearestTargetDate: string | null;
  nearestReleaseVersion: string | null;
  overdueCount: number;
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
  platformReadiness: PlatformReadinessSummary[];
}

export interface ReleaseGroupSection<T extends ReleaseEpicRecord = ReleaseEpicRecord> {
  key: string;
  label: string;
  color?: string;
  epics: T[];
  releaseCount: number;
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
}

export interface WorkItemGroupSection {
  key: string;
  label: string;
  badgeTone?: 'amber' | 'red' | 'green' | 'neutral';
  items: WorkItem[];
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
}

export interface ExpandedPlatformItemSummary {
  platform: ReleasePlatform;
  totalItems: number;
  greenItems: number;
  amberItems: number;
  redItems: number;
  leftToValidate: number;
  completionPercent: number;
}

/**
 * Maps any ADO work item state into the canonical Green / Amber / Red bucket.
 * Preserves the exact release status formula.
 */
export function getWorkItemValidationBucket(state?: string | null): ValidationBucket {
  const normalized = state ?? '';
  if ((GREEN_RELEASE_STATES as readonly string[]).includes(normalized)) {
    return 'green';
  }
  if ((AMBER_RELEASE_STATES as readonly string[]).includes(normalized)) {
    return 'amber';
  }
  return 'red';
}

/**
 * Unchanged completion formula: `totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0`.
 */
export function computeCompletionPercent(greenItems: number, totalItems: number): number {
  return totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0;
}

export function summarizeWorkItemsValidation(
  items: readonly { state?: string | null }[],
): ReleaseValidationSummary {
  let greenItems = 0;
  let amberItems = 0;
  let redItems = 0;

  for (const item of items) {
    const bucket = getWorkItemValidationBucket(item.state);
    if (bucket === 'green') greenItems += 1;
    else if (bucket === 'amber') amberItems += 1;
    else redItems += 1;
  }

  const totalItems = items.length;
  const leftToValidate = amberItems + redItems;
  return {
    totalItems,
    greenItems,
    amberItems,
    redItems,
    leftToValidate,
    completionPercent: computeCompletionPercent(greenItems, totalItems),
  };
}

/**
 * Extracts normalized counts from a Release Epic payload, preserving backwards compatibility
 * with older payloads that only carried `completedItems` and `totalItems`.
 */
export function getEpicValidationCounts(epic: ReleaseEpicRecord): ReleaseValidationSummary {
  const totalItems = Math.max(0, epic.totalItems ?? 0);
  const greenItems = Math.max(0, epic.greenItems ?? epic.completedItems ?? 0);
  const amberItems = Math.max(0, epic.amberItems ?? 0);
  const explicitRed = epic.redItems;
  const redItems =
    typeof explicitRed === 'number'
      ? Math.max(0, explicitRed)
      : Math.max(0, totalItems - greenItems - amberItems);

  const leftToValidate = amberItems + redItems;
  const completionPercent =
    typeof epic.progress === 'number'
      ? epic.progress
      : computeCompletionPercent(greenItems, totalItems);

  return {
    totalItems,
    greenItems,
    amberItems,
    redItems,
    leftToValidate,
    completionPercent,
  };
}

export function getReleaseLifecycleStage(
  status?: string | null,
): 'in-flight' | 'planned' | 'shipped' {
  const normalized = (status ?? '').trim();
  if ((SHIPPED_RELEASE_STATUSES as readonly string[]).includes(normalized)) {
    return 'shipped';
  }
  if ((IN_FLIGHT_RELEASE_STATUSES as readonly string[]).includes(normalized)) {
    return 'in-flight';
  }
  return 'planned';
}

export function isSlatedRelease(epic: Pick<ReleaseEpicRecord, 'status'>): boolean {
  return getReleaseLifecycleStage(epic.status) !== 'shipped';
}

export function matchesLifecycleFilter(
  epic: Pick<ReleaseEpicRecord, 'status'>,
  mode: ReleaseLifecycleFilter,
): boolean {
  if (mode === 'all') return true;
  const stage = getReleaseLifecycleStage(epic.status);
  if (mode === 'slated') return stage !== 'shipped';
  return stage === mode;
}

export function computeLifecycleCounts(
  epics: readonly Pick<ReleaseEpicRecord, 'status'>[],
): Record<ReleaseLifecycleFilter, number> {
  const counts: Record<ReleaseLifecycleFilter, number> = {
    all: epics.length,
    slated: 0,
    'in-flight': 0,
    planned: 0,
    shipped: 0,
  };

  for (const epic of epics) {
    const stage = getReleaseLifecycleStage(epic.status);
    counts[stage] += 1;
    if (stage !== 'shipped') {
      counts.slated += 1;
    }
  }

  return counts;
}

function stripHtmlTags(raw?: string | null): string {
  if (!raw) return '';
  return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function filterReleaseEpics<T extends ReleaseEpicRecord>(options: {
  epics: readonly T[];
  lifecycleFilter: ReleaseLifecycleFilter;
  platformFilterSlug: string | null;
  searchText: string;
  platforms: readonly ReleasePlatform[];
  epicPlatformIds: Readonly<Record<number, readonly string[]>>;
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
  loadedChildrenByEpic?: ReadonlyMap<number, readonly WorkItem[]>;
}): T[] {
  const {
    epics,
    lifecycleFilter,
    platformFilterSlug,
    searchText,
    platforms,
    epicPlatformIds,
    workItemPlatformIds,
    loadedChildrenByEpic,
  } = options;

  const normalizedQuery = searchText.trim().toLowerCase();

  return epics.filter((epic) => {
    if (!matchesLifecycleFilter(epic, lifecycleFilter)) {
      return false;
    }

    if (platformFilterSlug && platforms.length > 0) {
      const resolved = resolveReleaseEpicPlatforms(
        epic,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildrenByEpic?.get(epic.id),
      );
      if (platformFilterSlug === 'unassigned') {
        if (resolved.length > 0) return false;
      } else if (!resolved.some((p) => p.slug === platformFilterSlug)) {
        return false;
      }
    }

    if (normalizedQuery) {
      const versionMatch = (epic.version ?? '').toLowerCase().includes(normalizedQuery);
      const descMatch = stripHtmlTags(epic.description).toLowerCase().includes(normalizedQuery);
      if (!versionMatch && !descMatch) return false;
    }

    return true;
  });
}

function summarizeEpicsList<T extends ReleaseEpicRecord>(epics: readonly T[]) {
  let totalItems = 0;
  let greenItems = 0;
  let amberItems = 0;
  let redItems = 0;

  for (const epic of epics) {
    const counts = getEpicValidationCounts(epic);
    totalItems += counts.totalItems;
    greenItems += counts.greenItems;
    amberItems += counts.amberItems;
    redItems += counts.redItems;
  }

  return {
    totalItems,
    greenItems,
    amberItems,
    redItems,
    leftToValidate: amberItems + redItems,
    completionPercent: computeCompletionPercent(greenItems, totalItems),
  };
}

export function groupReleaseEpics<T extends ReleaseEpicRecord>(options: {
  epics: readonly T[];
  groupBy: ReleaseGroupBy;
  platforms: readonly ReleasePlatform[];
  epicPlatformIds: Readonly<Record<number, readonly string[]>>;
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
  loadedChildrenByEpic?: ReadonlyMap<number, readonly WorkItem[]>;
}): ReleaseGroupSection<T>[] {
  const {
    epics,
    groupBy,
    platforms,
    epicPlatformIds,
    workItemPlatformIds,
    loadedChildrenByEpic,
  } = options;

  if (groupBy === 'none') {
    const summary = summarizeEpicsList(epics);
    return [
      {
        key: 'all',
        label: 'All Releases',
        epics: [...epics],
        releaseCount: epics.length,
        ...summary,
      },
    ];
  }

  if (groupBy === 'lifecycle') {
    const definitions: Array<{
      key: 'in-flight' | 'planned' | 'shipped';
      label: string;
    }> = [
      { key: 'in-flight', label: 'In Flight' },
      { key: 'planned', label: 'Planned / Upcoming' },
      { key: 'shipped', label: 'Shipped / Completed' },
    ];

    return definitions
      .map((def) => {
        const matching = epics.filter(
          (epic) => getReleaseLifecycleStage(epic.status) === def.key,
        );
        const summary = summarizeEpicsList(matching);
        return {
          key: def.key,
          label: def.label,
          epics: matching,
          releaseCount: matching.length,
          ...summary,
        };
      })
      .filter((section) => section.epics.length > 0);
  }

  // groupBy === 'platform'
  if (platforms.length === 0) {
    const summary = summarizeEpicsList(epics);
    return [
      {
        key: 'unassigned',
        label: 'Unassigned Platform',
        epics: [...epics],
        releaseCount: epics.length,
        ...summary,
      },
    ];
  }

  const sections: ReleaseGroupSection<T>[] = [];
  for (const platform of platforms) {
    const matching = epics.filter((epic) => {
      const resolved = resolveReleaseEpicPlatforms(
        epic,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildrenByEpic?.get(epic.id),
      );
      return resolved.some((p) => p.id === platform.id);
    });
    if (matching.length > 0) {
      const summary = summarizeEpicsList(matching);
      sections.push({
        key: platform.slug,
        label: platform.name,
        color: platform.color,
        epics: matching,
        releaseCount: matching.length,
        ...summary,
      });
    }
  }

  const unassigned = epics.filter((epic) => {
    const resolved = resolveReleaseEpicPlatforms(
      epic,
      platforms,
      epicPlatformIds,
      workItemPlatformIds,
      loadedChildrenByEpic?.get(epic.id),
    );
    return resolved.length === 0;
  });

  if (unassigned.length > 0) {
    const summary = summarizeEpicsList(unassigned);
    sections.push({
      key: 'unassigned',
      label: 'Unassigned Platform',
      epics: unassigned,
      releaseCount: unassigned.length,
      ...summary,
    });
  }

  return sections;
}

/**
 * Computes the executive & QA Slated Release Overview across all slated (unshipped) releases.
 */
export function computeSlatedReleasesOverview(options: {
  epics: readonly ReleaseEpicRecord[];
  platforms: readonly ReleasePlatform[];
  epicPlatformIds: Readonly<Record<number, readonly string[]>>;
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
  loadedChildrenByEpic?: ReadonlyMap<number, readonly WorkItem[]>;
  todayIsoDate?: string;
}): SlatedReleasesOverview {
  const {
    epics,
    platforms,
    epicPlatformIds,
    workItemPlatformIds,
    loadedChildrenByEpic,
    todayIsoDate = new Date().toISOString().slice(0, 10),
  } = options;

  const slatedEpics = epics.filter(isSlatedRelease);
  const summary = summarizeEpicsList(slatedEpics);

  let nearestTargetDate: string | null = null;
  let nearestReleaseVersion: string | null = null;
  let overdueCount = 0;

  const datedUpcoming: Array<{ date: string; version: string }> = [];
  for (const epic of slatedEpics) {
    const targetDate = epic.targetDate?.trim();
    if (!targetDate) continue;
    const epicCounts = getEpicValidationCounts(epic);
    if (targetDate < todayIsoDate && epicCounts.leftToValidate > 0) {
      overdueCount += 1;
    }
    datedUpcoming.push({ date: targetDate, version: epic.version });
  }

  if (datedUpcoming.length > 0) {
    // Prefer nearest future/today target date; otherwise earliest overdue date
    const futureOrToday = datedUpcoming
      .filter((entry) => entry.date >= todayIsoDate)
      .sort((a, b) => a.date.localeCompare(b.date));
    const chosen =
      futureOrToday[0] ??
      [...datedUpcoming].sort((a, b) => a.date.localeCompare(b.date))[0];
    if (chosen) {
      nearestTargetDate = chosen.date;
      nearestReleaseVersion = chosen.version;
    }
  }

  const platformReadiness: PlatformReadinessSummary[] = platforms.map((platform) => {
    let slatedReleaseCount = 0;
    let totalItems = 0;
    let greenItems = 0;
    let amberItems = 0;
    let redItems = 0;

    for (const epic of slatedEpics) {
      const loadedChildren = loadedChildrenByEpic?.get(epic.id);
      const epicExplicitIds = epicPlatformIds[epic.id] ?? [];
      const resolvedEpicPlatforms = resolveReleaseEpicPlatforms(
        epic,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildren,
      );

      const shipsToPlatform = resolvedEpicPlatforms.some((p) => p.id === platform.id);
      if (!shipsToPlatform) continue;

      slatedReleaseCount += 1;

      const itemsSource: readonly { id: number; state: string; tags?: string }[] | undefined =
        loadedChildren ?? epic.childItemsSummary;

      if (itemsSource && itemsSource.length > 0) {
        const epicExplicitlyTargetsPlatform = epicExplicitIds.includes(platform.id);
        for (const item of itemsSource) {
          const itemPlatforms = resolveWorkItemPlatforms(
            item,
            platforms,
            workItemPlatformIds,
          );
          const itemMatchesPlatform =
            itemPlatforms.some((p) => p.id === platform.id) ||
            (itemPlatforms.length === 0 && epicExplicitlyTargetsPlatform);

          if (!itemMatchesPlatform) continue;

          totalItems += 1;
          const bucket = getWorkItemValidationBucket(item.state);
          if (bucket === 'green') greenItems += 1;
          else if (bucket === 'amber') amberItems += 1;
          else redItems += 1;
        }
      } else {
        // Fallback when child summary is absent: attribute epic-level counts to its assigned platforms
        const epicCounts = getEpicValidationCounts(epic);
        totalItems += epicCounts.totalItems;
        greenItems += epicCounts.greenItems;
        amberItems += epicCounts.amberItems;
        redItems += epicCounts.redItems;
      }
    }

    const leftToValidate = amberItems + redItems;
    return {
      platform,
      slatedReleaseCount,
      totalItems,
      greenItems,
      amberItems,
      redItems,
      leftToValidate,
      completionPercent: computeCompletionPercent(greenItems, totalItems),
    };
  });

  return {
    slatedReleaseCount: slatedEpics.length,
    nearestTargetDate,
    nearestReleaseVersion,
    overdueCount,
    ...summary,
    platformReadiness,
  };
}

export function computeExpandedPlatformSummaries(options: {
  items: readonly WorkItem[];
  platforms: readonly ReleasePlatform[];
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
}): ExpandedPlatformItemSummary[] {
  const { items, platforms, workItemPlatformIds } = options;
  if (platforms.length === 0) return [];

  return platforms.map((platform) => {
    const matching = items.filter((item) =>
      resolveWorkItemPlatforms(item, platforms, workItemPlatformIds).some(
        (p) => p.id === platform.id,
      ),
    );
    const summary = summarizeWorkItemsValidation(matching);
    return {
      platform,
      ...summary,
    };
  });
}

export function filterExpandedWorkItems(options: {
  items: readonly WorkItem[];
  bucketFilter: ExpandedItemFilter;
  platformSlugFilter: string | null;
  platforms: readonly ReleasePlatform[];
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
}): WorkItem[] {
  const {
    items,
    bucketFilter,
    platformSlugFilter,
    platforms,
    workItemPlatformIds,
  } = options;

  return items.filter((item) => {
    const bucket = getWorkItemValidationBucket(item.state);
    if (bucketFilter === 'left-to-validate' && bucket === 'green') return false;
    if (bucketFilter === 'uat-ready' && bucket !== 'amber') return false;
    if (bucketFilter === 'in-dev' && bucket !== 'red') return false;
    if (bucketFilter === 'validated' && bucket !== 'green') return false;

    if (platformSlugFilter && platforms.length > 0) {
      const resolved = resolveWorkItemPlatforms(item, platforms, workItemPlatformIds);
      if (platformSlugFilter === 'unassigned') {
        if (resolved.length > 0) return false;
      } else if (!resolved.some((p) => p.slug === platformSlugFilter)) {
        return false;
      }
    }

    return true;
  });
}

export function groupExpandedWorkItems(options: {
  items: readonly WorkItem[];
  groupBy: ExpandedItemGroupBy;
  platforms: readonly ReleasePlatform[];
  workItemPlatformIds: Readonly<Record<number, readonly string[]>>;
}): WorkItemGroupSection[] {
  const { items, groupBy, platforms, workItemPlatformIds } = options;

  if (groupBy === 'none') {
    const summary = summarizeWorkItemsValidation(items);
    return [
      {
        key: 'all',
        label: 'All Work Items',
        items: [...items],
        ...summary,
      },
    ];
  }

  if (groupBy === 'validation') {
    const definitions: Array<{
      key: ValidationBucket;
      label: string;
      tone: 'amber' | 'red' | 'green';
    }> = [
      { key: 'amber', label: 'Ready for UAT / Validation', tone: 'amber' },
      { key: 'red', label: 'In Dev / Pre-UAT', tone: 'red' },
      { key: 'green', label: 'Validated & Ready', tone: 'green' },
    ];

    return definitions
      .map((def) => {
        const matching = items.filter(
          (item) => getWorkItemValidationBucket(item.state) === def.key,
        );
        const summary = summarizeWorkItemsValidation(matching);
        return {
          key: def.key,
          label: def.label,
          badgeTone: def.tone,
          items: matching,
          ...summary,
        };
      })
      .filter((section) => section.items.length > 0);
  }

  if (groupBy === 'platform') {
    const sections: WorkItemGroupSection[] = [];
    for (const platform of platforms) {
      const matching = items.filter((item) =>
        resolveWorkItemPlatforms(item, platforms, workItemPlatformIds).some(
          (p) => p.id === platform.id,
        ),
      );
      if (matching.length > 0) {
        const summary = summarizeWorkItemsValidation(matching);
        sections.push({
          key: platform.slug,
          label: platform.name,
          badgeTone: summary.leftToValidate === 0 ? 'green' : summary.amberItems > 0 ? 'amber' : 'neutral',
          items: matching,
          ...summary,
        });
      }
    }

    const unassigned = items.filter(
      (item) => resolveWorkItemPlatforms(item, platforms, workItemPlatformIds).length === 0,
    );
    if (unassigned.length > 0) {
      const summary = summarizeWorkItemsValidation(unassigned);
      sections.push({
        key: 'unassigned',
        label: 'Unassigned Platform',
        badgeTone: 'neutral',
        items: unassigned,
        ...summary,
      });
    }
    return sections;
  }

  // groupBy === 'type'
  const typeGroups: Array<{
    key: string;
    label: string;
    matches: (type: string) => boolean;
  }> = [
    { key: 'epics', label: 'Epics', matches: (t) => t === 'Epic' },
    { key: 'features', label: 'Features', matches: (t) => t === 'Feature' },
    {
      key: 'backlog-items',
      label: 'Backlog Items (PBI / TBI)',
      matches: (t) =>
        t === 'Product Backlog Item' ||
        t === 'Technical Backlog Item' ||
        t === 'User Story',
    },
    {
      key: 'bugs-other',
      label: 'Bugs / Other',
      matches: (t) =>
        t !== 'Epic' &&
        t !== 'Feature' &&
        t !== 'Product Backlog Item' &&
        t !== 'Technical Backlog Item' &&
        t !== 'User Story',
    },
  ];

  return typeGroups
    .map((group) => {
      const matching = items.filter((item) => group.matches(item.workItemType));
      const summary = summarizeWorkItemsValidation(matching);
      return {
        key: group.key,
        label: group.label,
        badgeTone: 'neutral' as const,
        items: matching,
        ...summary,
      };
    })
    .filter((section) => section.items.length > 0);
}
