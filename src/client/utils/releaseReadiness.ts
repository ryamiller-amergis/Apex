import { deriveReleasePlatform } from '../../shared/utils/releasePlatform';
import type { WorkItem } from '../types/workitem';

export interface ReleaseEpic {
  id: number;
  version: string;
  status: string;
  areaPath?: string;
  platform?: string;
  startDate?: string;
  targetDate?: string;
  description?: string;
  progress: number;
  totalItems: number;
  completedItems: number;
  greenItems?: number;
  amberItems?: number;
  redItems?: number;
}

export type LifecycleScope = 'active' | 'shipped' | 'all';
export type ReleaseSortBy = 'manual' | 'targetDate' | 'progress' | 'version';
export type InspectorWorkItemTab = 'needs-attention' | 'ready' | 'all';
export type ReadinessGapFilter = 'dev' | 'uat' | 'unassigned';
export type ReadinessBucket = 'green' | 'amber' | 'red';

const GREEN_STATES = new Set(['Ready For Release', 'UAT - Test Done', 'Done', 'Closed']);
const AMBER_STATES = new Set(['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test']);
const SHIPPED_STATUSES = new Set(['done', 'removed', 'closed']);
export const RENAMABLE_STATUSES = ['New', 'In Design', 'In Progress'] as const;

export function isRenamableStatus(status?: string): boolean {
  return (RENAMABLE_STATUSES as readonly string[]).includes(status ?? '');
}

export function getEpicPlatform(
  epic: Pick<ReleaseEpic, 'platform' | 'areaPath'>,
  project?: string,
): string {
  if (epic.platform && epic.platform.trim()) return epic.platform.trim();
  return deriveReleasePlatform(epic.areaPath, project);
}

export function isShippedStatus(status?: string): boolean {
  return SHIPPED_STATUSES.has((status ?? '').trim().toLowerCase());
}

export function collectAvailablePlatforms(epics: ReleaseEpic[], project?: string): string[] {
  const present = new Set(epics.map((e) => getEpicPlatform(e, project)));
  const ordered: string[] = [];
  if (present.has('Mobile')) ordered.push('Mobile');
  if (present.has('Desktop')) ordered.push('Desktop');
  const extras = [...present]
    .filter((p) => p !== 'Mobile' && p !== 'Desktop')
    .sort((a, b) => a.localeCompare(b));
  return ['All', ...ordered, ...extras];
}

export function filterReleaseEpics(
  epics: ReleaseEpic[],
  options: {
    platform: string;
    scope: LifecycleScope;
    search: string;
    project?: string;
  },
): ReleaseEpic[] {
  const query = options.search.trim().toLowerCase();
  const normalizedPlatform = options.platform.trim().toLowerCase();

  return epics.filter((epic) => {
    const shipped = isShippedStatus(epic.status);
    if (options.scope === 'active' && shipped) return false;
    if (options.scope === 'shipped' && !shipped) return false;

    if (normalizedPlatform && normalizedPlatform !== 'all') {
      const epicPlatform = getEpicPlatform(epic, options.project).toLowerCase();
      if (epicPlatform !== normalizedPlatform) return false;
    }

    if (query) {
      const plainDesc = (epic.description ?? '').replace(/<[^>]*>/g, '').toLowerCase();
      const haystack = `${epic.version} ${epic.status} ${getEpicPlatform(epic, options.project)} ${plainDesc}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

export function sortReleaseEpics(
  epics: ReleaseEpic[],
  sortBy: ReleaseSortBy,
  sortDirection: 'asc' | 'desc',
): ReleaseEpic[] {
  if (sortBy === 'manual') return epics;

  const dir = sortDirection === 'asc' ? 1 : -1;
  return [...epics].sort((a, b) => {
    if (sortBy === 'progress') {
      return ((a.progress ?? 0) - (b.progress ?? 0)) * dir;
    }

    if (sortBy === 'targetDate') {
      const aDate = a.targetDate?.slice(0, 10) ?? '';
      const bDate = b.targetDate?.slice(0, 10) ?? '';
      if (!aDate && !bDate) return 0;
      if (!aDate) return 1;
      if (!bDate) return -1;
      return aDate.localeCompare(bDate) * dir;
    }

    return (a.version || '').localeCompare(b.version || '', undefined, {
      numeric: true,
      sensitivity: 'base',
    }) * dir;
  });
}

export interface TargetDateCountdown {
  label: string;
  variant: 'none' | 'overdue' | 'due-soon' | 'upcoming' | 'shipped';
}

export function formatTargetDateCountdown(
  targetDate?: string,
  status?: string,
  now: Date = new Date(),
): TargetDateCountdown {
  if (!targetDate || !targetDate.trim()) {
    return { label: 'No target date', variant: 'none' };
  }

  const datePart = targetDate.trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) {
    return { label: targetDate, variant: isShippedStatus(status) ? 'shipped' : 'upcoming' };
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const targetLocal = new Date(year, month, day);
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const dateLabel = targetLocal.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(year !== now.getFullYear() ? { year: 'numeric' } : {}),
  });

  if (isShippedStatus(status)) {
    return { label: dateLabel, variant: 'shipped' };
  }

  const diffDays = Math.round((targetLocal.getTime() - todayLocal.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) {
    return { label: `${dateLabel} · Overdue`, variant: 'overdue' };
  }
  if (diffDays === 0) {
    return { label: `${dateLabel} · Today`, variant: 'due-soon' };
  }
  return {
    label: `${dateLabel} · ${diffDays}d left`,
    variant: diffDays <= 7 ? 'due-soon' : 'upcoming',
  };
}

export function getEpicBucketCounts(
  epic: Pick<ReleaseEpic, 'totalItems' | 'completedItems' | 'greenItems' | 'amberItems' | 'redItems'>,
): { total: number; green: number; amber: number; red: number } {
  const total = epic.totalItems ?? 0;
  const green = epic.greenItems ?? epic.completedItems ?? 0;
  const amber = epic.amberItems ?? 0;
  const red = epic.redItems ?? Math.max(0, total - green - amber);
  return { total, green, amber, red };
}

export function formatRemainingSummary(
  epic: Pick<ReleaseEpic, 'totalItems' | 'completedItems' | 'greenItems' | 'amberItems' | 'redItems'>,
): string {
  const { total, amber, red } = getEpicBucketCounts(epic);
  if (total === 0) return 'No items';
  if (red === 0 && amber === 0) return 'All ready';
  const parts: string[] = [];
  if (red > 0) parts.push(`${red} Dev`);
  if (amber > 0) parts.push(`${amber} UAT`);
  return parts.join(' · ');
}

export function classifyWorkItemReadiness(item: Pick<WorkItem, 'state'>): ReadinessBucket {
  if (GREEN_STATES.has(item.state)) return 'green';
  if (AMBER_STATES.has(item.state)) return 'amber';
  return 'red';
}

export interface ReleaseReadinessSummary {
  readyCount: number;
  uatCount: number;
  notReadyCount: number;
  unassignedCount: number;
  missingTargetDate: boolean;
  missingOutcome: boolean;
  isAllClear: boolean;
}

export function computeReleaseReadiness(
  items: WorkItem[],
  epic: Pick<ReleaseEpic, 'targetDate'>,
  hasOutcome: boolean,
): ReleaseReadinessSummary {
  let readyCount = 0;
  let uatCount = 0;
  let notReadyCount = 0;
  let unassignedCount = 0;

  for (const item of items) {
    const bucket = classifyWorkItemReadiness(item);
    if (bucket === 'green') readyCount++;
    else if (bucket === 'amber') uatCount++;
    else notReadyCount++;

    if (!item.assignedTo || !item.assignedTo.trim()) {
      unassignedCount++;
    }
  }

  const missingTargetDate = !epic.targetDate || !epic.targetDate.trim();
  const missingOutcome = !hasOutcome;
  const isAllClear =
    items.length > 0 &&
    notReadyCount === 0 &&
    uatCount === 0 &&
    unassignedCount === 0 &&
    !missingTargetDate &&
    !missingOutcome;

  return {
    readyCount,
    uatCount,
    notReadyCount,
    unassignedCount,
    missingTargetDate,
    missingOutcome,
    isAllClear,
  };
}

function itemUrgencyRank(item: WorkItem): number {
  const bucket = classifyWorkItemReadiness(item);
  if (bucket === 'red') {
    return item.state === 'Blocked' ? 0 : 1;
  }
  if (bucket === 'amber') return 2;
  return 3;
}

export function filterAndSortInspectorItems(
  items: WorkItem[],
  tab: InspectorWorkItemTab,
  gapFilter: ReadinessGapFilter | null,
): WorkItem[] {
  const filtered = items.filter((item) => {
    if (gapFilter === 'dev') return classifyWorkItemReadiness(item) === 'red';
    if (gapFilter === 'uat') return classifyWorkItemReadiness(item) === 'amber';
    if (gapFilter === 'unassigned') return !item.assignedTo || !item.assignedTo.trim();

    if (tab === 'needs-attention') {
      const bucket = classifyWorkItemReadiness(item);
      return bucket === 'red' || bucket === 'amber';
    }
    if (tab === 'ready') {
      return classifyWorkItemReadiness(item) === 'green';
    }
    return true;
  });

  return filtered
    .map((item, idx) => ({ item, idx, rank: itemUrgencyRank(item) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.idx - b.idx))
    .map((entry) => entry.item);
}
