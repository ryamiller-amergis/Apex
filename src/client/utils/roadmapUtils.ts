import type { WorkItem } from '../types/workitem';
import type {
  RoadmapAdhocIdeaDto,
  RoadmapChangeEventDto,
  RoadmapConfidence,
  RoadmapEffortSize,
  RoadmapHorizon,
  RoadmapItemOrigin,
  RoadmapPlanOverlayDto,
  RoadmapScheduleSource,
} from '../../shared/types/roadmap';

export interface RoadmapItem {
  id: number;
  title: string;
  workItemType: string;
  targetDate: string;
  assignedTo?: string;
  state: string;
  createdDate: string;
  completionPercentage: number;
  childCount: number;
  completedCount: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  healthStatus: 'on-track' | 'in-progress' | 'behind' | 'ahead';
  daysRemaining: number;
  timeElapsedPercentage: number;
  children?: WorkItem[];
}

export interface TimelineColumn {
  label: string;
  startDate: Date;
  endDate: Date;
  isCurrentPeriod: boolean;
}

export interface WeightedRollup {
  totalCount: number;
  doneCount: number;
  uatCount: number;
  inProgressCount: number;
  todoCount: number;
  donePct: number;
  uatPct: number;
  inProgressPct: number;
  todoPct: number;
  weightedCompletionPct: number;
}

export type WorkbenchHealthStatus =
  | 'on-track'
  | 'ahead'
  | 'in-progress'
  | 'behind'
  | 'unscheduled';

export interface ResolvedSchedule {
  scheduleSource: RoadmapScheduleSource;
  effectiveStartDate: string | null;
  effectiveTargetDate: string | null;
  baselineTargetDate: string | null;
  slipDays: number | null;
}

export interface RoadmapWorkbenchItem {
  key: string;
  kind: 'work-item' | 'adhoc-idea';
  workItemId?: number;
  ideaId?: string;
  title: string;
  origin: RoadmapItemOrigin;
  workItemType: string;
  state: string;
  ownerLabel: string;
  horizon: RoadmapHorizon;
  isHorizonOverridden: boolean;
  scheduleSource: RoadmapScheduleSource;
  effectiveStartDate: string | null;
  effectiveTargetDate: string | null;
  baselineTargetDate: string | null;
  slipDays: number | null;
  confidence: RoadmapConfidence | null;
  effortSize: RoadmapEffortSize | null;
  releaseLabel: string | null;
  notes: string | null;
  completionPercentage: number;
  weightedProgress: WeightedRollup;
  healthStatus: WorkbenchHealthStatus;
  daysRemaining: number | null;
  isCompleted: boolean;
  sortOrder: number;
  promotedFeatureRequestId: string | null;
  promotedAdoWorkItemId: number | null;
  workItem?: WorkItem;
  overlay?: RoadmapPlanOverlayDto;
  idea?: RoadmapAdhocIdeaDto;
  children: WorkItem[];
}

export interface TimelineBarGeometry {
  leftPct: number;
  widthPct: number;
  clampedStart: boolean;
  clampedEnd: boolean;
}

export interface RoadmapDriftKpis {
  activeNowNextCount: number;
  baselineAdherencePct: number;
  avgSlipDays: number;
  auditedMovesCount: number;
}

const DATE_YMD_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

const COMPLETED_STATES = new Set([
  'Done',
  'Closed',
  'Completed',
  'Shipped',
  'Resolved',
]);

const DONE_ROLLUP_STATES = new Set([
  'Ready For Release',
  'UAT - Test Done',
  'Done',
  'Closed',
  'Completed',
]);

const UAT_ROLLUP_STATES = new Set([
  'UAT - Ready For Test',
  'UAT Ready For Test',
  'UAT-Ready For Test',
]);

const ACTIVE_WORK_STATES = new Set([
  'In Progress',
  'Active',
  'In Pull Request',
  'Ready For Test',
  'In Test',
  'Review',
]);

export function extractYmdDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(DATE_YMD_PREFIX);
  return match ? match[1] : null;
}

export function parseLocalYmd(ymd: string): Date {
  const [year, month, day] = ymd.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function formatShortDate(ymd: string | null | undefined): string {
  const clean = extractYmdDate(ymd);
  if (!clean) return 'No date';
  const date = parseLocalYmd(clean);
  if (Number.isNaN(date.getTime())) return 'No date';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function calculateSlipDays(
  baselineDate: string | null | undefined,
  currentTargetDate: string | null | undefined,
): number | null {
  const base = extractYmdDate(baselineDate);
  const target = extractYmdDate(currentTargetDate);
  if (!base || !target) return null;
  const [by, bm, bd] = base.split('-').map(Number);
  const [ty, tm, td] = target.split('-').map(Number);
  const baseUtc = Date.UTC(by, bm - 1, bd);
  const targetUtc = Date.UTC(ty, tm - 1, td);
  return Math.round((targetUtc - baseUtc) / 86_400_000);
}

export function shiftIsoDate(
  baseYmd: string | null | undefined,
  delta: { days?: number; months?: number },
  fallbackNow: Date = new Date(),
): string {
  const clean = extractYmdDate(baseYmd);
  let year: number;
  let monthIndex: number;
  let day: number;
  if (clean) {
    const parts = clean.split('-').map(Number);
    year = parts[0];
    monthIndex = parts[1] - 1;
    day = parts[2];
  } else {
    year = fallbackNow.getFullYear();
    monthIndex = fallbackNow.getMonth();
    day = fallbackNow.getDate();
  }

  const utcDate = new Date(Date.UTC(year, monthIndex, day));
  if (delta.months) {
    utcDate.setUTCMonth(utcDate.getUTCMonth() + delta.months);
  }
  if (delta.days) {
    utcDate.setUTCDate(utcDate.getUTCDate() + delta.days);
  }
  const yyyy = utcDate.getUTCFullYear();
  const mm = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utcDate.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function resolveWorkItemSchedule(
  workItem: Pick<WorkItem, 'targetDate' | 'dueDate' | 'createdDate'>,
  overlay: RoadmapPlanOverlayDto | undefined,
  children: WorkItem[] = [],
): ResolvedSchedule {
  const overlayStart = extractYmdDate(overlay?.plannedStartDate);
  const overlayTarget = extractYmdDate(overlay?.plannedTargetDate);
  const overlayBaseline = extractYmdDate(overlay?.baselineTargetDate);
  const createdYmd = extractYmdDate(workItem.createdDate);

  // Tier 1: Apex Plan overlay target date
  if (overlayTarget) {
    const effectiveStart =
      overlayStart && overlayStart <= overlayTarget
        ? overlayStart
        : createdYmd && createdYmd <= overlayTarget
          ? createdYmd
          : overlayTarget;
    const baseline = overlayBaseline ?? overlayTarget;
    return {
      scheduleSource: 'apex-plan',
      effectiveStartDate: effectiveStart,
      effectiveTargetDate: overlayTarget,
      baselineTargetDate: baseline,
      slipDays: calculateSlipDays(baseline, overlayTarget),
    };
  }

  // Tier 2: Azure DevOps / Board TargetDate
  const adoTarget = extractYmdDate(workItem.targetDate);
  if (adoTarget) {
    const effectiveStart =
      overlayStart && overlayStart <= adoTarget
        ? overlayStart
        : createdYmd && createdYmd <= adoTarget
          ? createdYmd
          : adoTarget;
    const baseline = overlayBaseline ?? adoTarget;
    return {
      scheduleSource: 'ado-target',
      effectiveStartDate: effectiveStart,
      effectiveTargetDate: adoTarget,
      baselineTargetDate: baseline,
      slipDays: calculateSlipDays(baseline, adoTarget),
    };
  }

  // Tier 3: Inferred from active child Features / PBIs / TBIs / Bugs
  const activeChildren = children.filter((child) => child.state !== 'Removed');
  const childDates = activeChildren
    .flatMap((child) => [
      extractYmdDate(child.targetDate),
      extractYmdDate(child.dueDate),
    ])
    .filter((d): d is string => d !== null)
    .sort();

  if (childDates.length > 0) {
    const maxChildDate = childDates[childDates.length - 1];
    const minChildDate = childDates[0];
    const candidateStart = overlayStart ?? createdYmd ?? minChildDate;
    const effectiveStart =
      candidateStart <= maxChildDate ? candidateStart : minChildDate;
    const baseline = overlayBaseline ?? null;
    return {
      scheduleSource: 'inferred-child',
      effectiveStartDate: effectiveStart,
      effectiveTargetDate: maxChildDate,
      baselineTargetDate: baseline,
      slipDays: calculateSlipDays(baseline, maxChildDate),
    };
  }

  // Tier 4: Unscheduled (Horizon only)
  return {
    scheduleSource: 'unscheduled',
    effectiveStartDate: overlayStart ?? null,
    effectiveTargetDate: null,
    baselineTargetDate: overlayBaseline ?? null,
    slipDays: null,
  };
}

export function deriveDefaultHorizon(
  state: string,
  effectiveTargetDate: string | null,
  now: Date = new Date(),
): RoadmapHorizon {
  if (
    ACTIVE_WORK_STATES.has(state) ||
    UAT_ROLLUP_STATES.has(state)
  ) {
    return 'now';
  }
  if (effectiveTargetDate) {
    const remaining = calculateDaysRemainingFromDate(effectiveTargetDate, now);
    if (remaining > 60) {
      return 'later';
    }
  }
  return 'unplanned';
}

export function calculateWeightedRollup(children: WorkItem[]): WeightedRollup {
  const activeChildren = children.filter((c) => c.state !== 'Removed');
  const totalCount = activeChildren.length;
  if (totalCount === 0) {
    return {
      totalCount: 0,
      doneCount: 0,
      uatCount: 0,
      inProgressCount: 0,
      todoCount: 0,
      donePct: 0,
      uatPct: 0,
      inProgressPct: 0,
      todoPct: 0,
      weightedCompletionPct: 0,
    };
  }

  let doneCount = 0;
  let uatCount = 0;
  let inProgressCount = 0;
  let todoCount = 0;
  let weightedPoints = 0;

  for (const child of activeChildren) {
    if (DONE_ROLLUP_STATES.has(child.state)) {
      doneCount += 1;
      weightedPoints += 100;
    } else if (UAT_ROLLUP_STATES.has(child.state)) {
      uatCount += 1;
      weightedPoints += 75;
    } else if (ACTIVE_WORK_STATES.has(child.state)) {
      inProgressCount += 1;
      weightedPoints += 50;
    } else {
      todoCount += 1;
    }
  }

  return {
    totalCount,
    doneCount,
    uatCount,
    inProgressCount,
    todoCount,
    donePct: (doneCount / totalCount) * 100,
    uatPct: (uatCount / totalCount) * 100,
    inProgressPct: (inProgressCount / totalCount) * 100,
    todoPct: (todoCount / totalCount) * 100,
    weightedCompletionPct: Math.round(weightedPoints / totalCount),
  };
}

export function calculateDaysRemainingFromDate(
  targetDate: string,
  now: Date = new Date(),
): number {
  const clean = extractYmdDate(targetDate);
  if (!clean) return 0;
  const [year, month, day] = clean.split('-').map(Number);
  const target = new Date(year, month - 1, day, 0, 0, 0, 0);
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const diffTime = target.getTime() - today.getTime();
  return Math.ceil(diffTime / 86_400_000);
}

export function buildWorkbenchItems(params: {
  workItems: WorkItem[];
  overlays: RoadmapPlanOverlayDto[];
  ideas: RoadmapAdhocIdeaDto[];
  childrenByEpicId: ReadonlyMap<number, WorkItem[]>;
  selectedStatuses: ReadonlySet<string>;
  showAdhocIdeas: boolean;
  searchQuery: string;
  usesBoardWorkItems?: boolean;
  now?: Date;
}): RoadmapWorkbenchItem[] {
  const {
    workItems,
    overlays,
    ideas,
    childrenByEpicId,
    selectedStatuses,
    showAdhocIdeas,
    searchQuery,
    usesBoardWorkItems = false,
    now = new Date(),
  } = params;

  const overlayByWorkItemId = new Map<number, RoadmapPlanOverlayDto>();
  for (const overlay of overlays) {
    overlayByWorkItemId.set(overlay.workItemId, overlay);
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (title: string, owner: string, notes: string | null) => {
    if (!normalizedQuery) return true;
    return (
      title.toLowerCase().includes(normalizedQuery) ||
      owner.toLowerCase().includes(normalizedQuery) ||
      (notes ?? '').toLowerCase().includes(normalizedQuery)
    );
  };

  const inMemoryChildrenByParent = new Map<number, WorkItem[]>();
  for (const wi of workItems) {
    if (typeof wi.parentId === 'number') {
      const list = inMemoryChildrenByParent.get(wi.parentId) ?? [];
      list.push(wi);
      inMemoryChildrenByParent.set(wi.parentId, list);
    }
  }

  const results: RoadmapWorkbenchItem[] = [];
  const visibleWorkItemIds = new Set<number>();

  for (const item of workItems) {
    if (item.workItemType !== 'Epic') continue;
    if (item.tags?.includes('ReleaseVersion')) continue;
    if (selectedStatuses.size > 0 && !selectedStatuses.has(item.state)) {
      continue;
    }

    const overlay = overlayByWorkItemId.get(item.id);
    const ownerLabel = item.assignedTo?.trim() || 'Unassigned';
    if (!matchesQuery(item.title, ownerLabel, overlay?.notes ?? null)) {
      continue;
    }

    visibleWorkItemIds.add(item.id);

    const fetchedChildren = childrenByEpicId.get(item.id);
    const fallbackChildren = inMemoryChildrenByParent.get(item.id) ?? [];
    const children =
      fetchedChildren && fetchedChildren.length > 0
        ? fetchedChildren
        : fallbackChildren;

    const resolved = resolveWorkItemSchedule(item, overlay, children);
    const isCompleted = COMPLETED_STATES.has(item.state);
    const weightedProgress = calculateWeightedRollup(children);
    const completionPercentage =
      weightedProgress.totalCount > 0
        ? weightedProgress.weightedCompletionPct
        : isCompleted
          ? 100
          : 0;

    let healthStatus: WorkbenchHealthStatus = 'unscheduled';
    let daysRemaining: number | null = null;
    if (resolved.effectiveTargetDate) {
      daysRemaining = calculateDaysRemainingFromDate(
        resolved.effectiveTargetDate,
        now,
      );
      const startRef =
        resolved.effectiveStartDate ??
        extractYmdDate(item.createdDate) ??
        resolved.effectiveTargetDate;
      const elapsed = calculateTimeElapsed(
        startRef,
        resolved.effectiveTargetDate,
      );
      const remainingItems =
        weightedProgress.todoCount +
        weightedProgress.inProgressCount * 0.5 +
        weightedProgress.uatCount * 0.25;
      healthStatus = isCompleted
        ? 'on-track'
        : calculateHealthStatus(
            completionPercentage,
            elapsed,
            daysRemaining,
            weightedProgress.totalCount > 0 ? remainingItems : undefined,
          );
    }

    const horizon: RoadmapHorizon =
      overlay?.horizon ??
      deriveDefaultHorizon(item.state, resolved.effectiveTargetDate, now);

    const origin: RoadmapItemOrigin =
      item.source === 'board' || usesBoardWorkItems ? 'board' : 'ado';

    results.push({
      key: `wi-${item.id}`,
      kind: 'work-item',
      workItemId: item.id,
      title: item.title,
      origin,
      workItemType: item.workItemType,
      state: item.state,
      ownerLabel,
      horizon,
      isHorizonOverridden: overlay?.horizon !== null && overlay?.horizon !== undefined,
      scheduleSource: resolved.scheduleSource,
      effectiveStartDate: resolved.effectiveStartDate,
      effectiveTargetDate: resolved.effectiveTargetDate,
      baselineTargetDate: resolved.baselineTargetDate,
      slipDays: resolved.slipDays,
      confidence: overlay?.confidence ?? null,
      effortSize: null,
      releaseLabel: null,
      notes: overlay?.notes ?? null,
      completionPercentage,
      weightedProgress,
      healthStatus,
      daysRemaining,
      isCompleted,
      sortOrder: overlay?.sortOrder ?? 0,
      promotedFeatureRequestId: null,
      promotedAdoWorkItemId: null,
      workItem: item,
      overlay,
      children,
    });
  }

  if (showAdhocIdeas) {
    for (const idea of ideas) {
      if (idea.archived) continue;
      if (
        idea.promotedAdoWorkItemId &&
        visibleWorkItemIds.has(idea.promotedAdoWorkItemId)
      ) {
        continue;
      }

      const ownerLabel = idea.ownerLabel?.trim() || 'Unassigned';
      if (!matchesQuery(idea.title, ownerLabel, idea.notes)) {
        continue;
      }

      const targetYmd = extractYmdDate(idea.plannedTargetDate);
      const startYmd =
        extractYmdDate(idea.plannedStartDate) ??
        (targetYmd
          ? extractYmdDate(idea.createdAt) &&
            extractYmdDate(idea.createdAt)! <= targetYmd
            ? extractYmdDate(idea.createdAt)
            : targetYmd
          : null);
      const baselineYmd = extractYmdDate(idea.baselineTargetDate) ?? targetYmd;
      const slipDays = calculateSlipDays(baselineYmd, targetYmd);

      const daysRemaining = targetYmd
        ? calculateDaysRemainingFromDate(targetYmd, now)
        : null;
      const healthStatus: WorkbenchHealthStatus = targetYmd
        ? daysRemaining !== null && daysRemaining < 0
          ? 'behind'
          : 'on-track'
        : 'unscheduled';

      results.push({
        key: `idea-${idea.id}`,
        kind: 'adhoc-idea',
        ideaId: idea.id,
        title: idea.title,
        origin: 'adhoc',
        workItemType: 'Draft Idea',
        state: idea.promotedFeatureRequestId
          ? 'Promoted'
          : idea.promotedAdoWorkItemId
            ? 'Promoted'
            : 'Draft',
        ownerLabel,
        horizon: idea.horizon,
        isHorizonOverridden: true,
        scheduleSource: targetYmd ? 'apex-plan' : 'unscheduled',
        effectiveStartDate: startYmd,
        effectiveTargetDate: targetYmd,
        baselineTargetDate: baselineYmd,
        slipDays,
        confidence: idea.confidence,
        effortSize: idea.effortSize,
        releaseLabel: idea.releaseLabel,
        notes: idea.notes,
        completionPercentage: 0,
        weightedProgress: {
          totalCount: 0,
          doneCount: 0,
          uatCount: 0,
          inProgressCount: 0,
          todoCount: 0,
          donePct: 0,
          uatPct: 0,
          inProgressPct: 0,
          todoPct: 0,
          weightedCompletionPct: 0,
        },
        healthStatus,
        daysRemaining,
        isCompleted: false,
        sortOrder: idea.sortOrder,
        promotedFeatureRequestId: idea.promotedFeatureRequestId,
        promotedAdoWorkItemId: idea.promotedAdoWorkItemId,
        idea,
        children: [],
      });
    }
  }

  return results.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if (a.effectiveTargetDate && b.effectiveTargetDate) {
      if (a.effectiveTargetDate !== b.effectiveTargetDate) {
        return a.effectiveTargetDate.localeCompare(b.effectiveTargetDate);
      }
    } else if (a.effectiveTargetDate) {
      return -1;
    } else if (b.effectiveTargetDate) {
      return 1;
    }
    return a.title.localeCompare(b.title);
  });
}

export function computeTimelineBarGeometry(
  startYmd: string | null | undefined,
  endYmd: string | null | undefined,
  columns: TimelineColumn[],
): TimelineBarGeometry | null {
  const cleanEnd = extractYmdDate(endYmd);
  if (!cleanEnd || columns.length === 0) return null;
  const cleanStart = extractYmdDate(startYmd) ?? cleanEnd;

  const rangeStartMs = columns[0].startDate.getTime();
  const rangeEndMs = columns[columns.length - 1].endDate.getTime();
  const totalMs = rangeEndMs - rangeStartMs;
  if (totalMs <= 0) return null;

  const itemStartMs = parseLocalYmd(cleanStart).getTime();
  const itemEndMs = parseLocalYmd(cleanEnd).getTime();

  if (itemEndMs < rangeStartMs || itemStartMs > rangeEndMs) {
    return null;
  }

  const clampedStartMs = Math.max(rangeStartMs, Math.min(itemStartMs, itemEndMs));
  const clampedEndMs = Math.min(rangeEndMs, Math.max(itemStartMs, itemEndMs));

  const leftPct = ((clampedStartMs - rangeStartMs) / totalMs) * 100;
  const rawWidthPct = ((clampedEndMs - clampedStartMs) / totalMs) * 100;
  const widthPct = Math.max(3.5, Math.min(100 - leftPct, rawWidthPct));

  return {
    leftPct,
    widthPct,
    clampedStart: itemStartMs < rangeStartMs,
    clampedEnd: itemEndMs > rangeEndMs,
  };
}

export function computeTodayMarkerPercent(
  columns: TimelineColumn[],
  now: Date = new Date(),
): number | null {
  if (columns.length === 0) return null;
  const rangeStartMs = columns[0].startDate.getTime();
  const rangeEndMs = columns[columns.length - 1].endDate.getTime();
  const totalMs = rangeEndMs - rangeStartMs;
  if (totalMs <= 0) return null;
  const nowMs = now.getTime();
  if (nowMs < rangeStartMs || nowMs > rangeEndMs) return null;
  return ((nowMs - rangeStartMs) / totalMs) * 100;
}

export function calculateRoadmapDriftKpis(
  items: RoadmapWorkbenchItem[],
  events: RoadmapChangeEventDto[],
): RoadmapDriftKpis {
  const activeNowNextCount = items.filter(
    (item) =>
      !item.isCompleted && (item.horizon === 'now' || item.horizon === 'next'),
  ).length;

  const baselineTracked = items.filter(
    (item) => item.baselineTargetDate && item.effectiveTargetDate,
  );
  const adheringCount = baselineTracked.filter(
    (item) => (item.slipDays ?? 0) <= 0,
  ).length;
  const baselineAdherencePct =
    baselineTracked.length > 0
      ? Math.round((adheringCount / baselineTracked.length) * 100)
      : 100;

  const positiveSlips = baselineTracked
    .map((item) => item.slipDays ?? 0)
    .filter((days) => days > 0);
  const avgSlipDays =
    positiveSlips.length > 0
      ? Math.round(
          positiveSlips.reduce((sum, days) => sum + days, 0) /
            positiveSlips.length,
        )
      : 0;

  return {
    activeNowNextCount,
    baselineAdherencePct,
    avgSlipDays,
    auditedMovesCount: events.length,
  };
}

export function getScheduleSourceLabel(source: RoadmapScheduleSource): string {
  const labels: Record<RoadmapScheduleSource, string> = {
    'apex-plan': 'Apex Plan',
    'ado-target': 'ADO Target',
    'inferred-child': 'Inferred (Children)',
    unscheduled: 'No Date (Horizon Only)',
  };
  return labels[source];
}

export function getHorizonLabel(horizon: RoadmapHorizon): string {
  const labels: Record<RoadmapHorizon, string> = {
    now: 'Now',
    next: 'Next',
    later: 'Later',
    unplanned: 'Unplanned',
  };
  return labels[horizon];
}

export function getOriginLabel(origin: RoadmapItemOrigin): string {
  const labels: Record<RoadmapItemOrigin, string> = {
    ado: 'ADO Epic',
    board: 'Board Epic',
    adhoc: 'Draft Idea',
  };
  return labels[origin];
}

/**
 * Calculate the health status of a work item based on progress vs. time elapsed
 */
export function calculateHealthStatus(
  completionPercentage: number,
  timeElapsedPercentage: number,
  daysRemaining: number,
  remainingItems?: number,
): 'on-track' | 'in-progress' | 'behind' | 'ahead' {
  const PLANNING_HORIZON_DAYS = 60;
  const REASONABLE_ITEMS_PER_DAY = 1;

  if (daysRemaining < 0) {
    return completionPercentage >= 100 ? 'on-track' : 'behind';
  }

  if (completionPercentage >= 100) {
    return 'on-track';
  }

  if (daysRemaining > PLANNING_HORIZON_DAYS && completionPercentage === 0) {
    return 'on-track';
  }

  if (remainingItems !== undefined && remainingItems > 0) {
    const daysNeeded = remainingItems / REASONABLE_ITEMS_PER_DAY;
    if (daysRemaining >= daysNeeded * 1.2) {
      return 'on-track';
    }
  }

  if (completionPercentage > 0 || daysRemaining <= PLANNING_HORIZON_DAYS) {
    const progressDelta = completionPercentage - timeElapsedPercentage;

    if (progressDelta > 15) {
      return 'ahead';
    }

    if (progressDelta < -10) {
      return 'in-progress';
    }
  }

  return 'on-track';
}

export function calculateTimeElapsed(
  createdDate: string,
  targetDate: string,
): number {
  const cleanCreated = extractYmdDate(createdDate) ?? createdDate;
  const cleanTarget = extractYmdDate(targetDate) ?? targetDate;
  const parseLocalDate = (dateStr: string) => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
  };

  const created = parseLocalDate(cleanCreated);
  const target = parseLocalDate(cleanTarget);
  const now = new Date();

  const totalDuration = target.getTime() - created.getTime();
  const elapsed = now.getTime() - created.getTime();

  if (totalDuration <= 0) return 100;

  const percentage = (elapsed / totalDuration) * 100;
  return Math.max(0, Math.min(100, percentage));
}

export function calculateDaysRemaining(targetDate: string): number {
  return calculateDaysRemainingFromDate(targetDate, new Date());
}

export function calculateCompletionPercentage(children: WorkItem[]): number {
  if (!children || children.length === 0) return 0;

  const activeChildren = children.filter((child) => child.state !== 'Removed');
  if (activeChildren.length === 0) return 0;

  const isFeatureLevel = activeChildren.some(
    (child) => child.workItemType === 'Feature',
  );

  const completedStates = isFeatureLevel
    ? ['Done', 'Closed']
    : ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];

  const inProgressStates = [
    'In Progress',
    'In Pull Request',
    'Ready For Test',
    'In Test',
  ];

  let totalProgress = 0;

  activeChildren.forEach((child) => {
    if (completedStates.includes(child.state)) {
      totalProgress += 100;
    } else if (inProgressStates.includes(child.state)) {
      totalProgress += 50;
    }
  });

  return Math.round(totalProgress / activeChildren.length);
}

export function calculateSegmentedCounts(children: WorkItem[]): {
  greenCount: number;
  amberCount: number;
  redCount: number;
  activeTotal: number;
} {
  const activeChildren = children.filter((child) => child.state !== 'Removed');

  const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
  const amberStates = [
    'UAT - Ready For Test',
    'UAT Ready For Test',
    'UAT-Ready For Test',
  ];

  let greenCount = 0;
  let amberCount = 0;
  let redCount = 0;

  activeChildren.forEach((child) => {
    if (greenStates.includes(child.state)) {
      greenCount++;
    } else if (amberStates.includes(child.state)) {
      amberCount++;
    } else {
      redCount++;
    }
  });

  return {
    greenCount,
    amberCount,
    redCount,
    activeTotal: activeChildren.length,
  };
}

export function generateMonthlyTimeline(
  startDate: Date,
  endDate: Date,
): TimelineColumn[] {
  const columns: TimelineColumn[] = [];
  const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  while (current <= endDate) {
    const year = current.getFullYear();
    const month = current.getMonth();

    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);

    const isCurrentPeriod = year === currentYear && month === currentMonth;

    columns.push({
      label: monthStart.toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      }),
      startDate: monthStart,
      endDate: monthEnd,
      isCurrentPeriod,
    });

    current.setMonth(current.getMonth() + 1);
  }

  return columns;
}

export function generateQuarterlyTimeline(
  startDate: Date,
  endDate: Date,
): TimelineColumn[] {
  const columns: TimelineColumn[] = [];
  const startQuarter = Math.floor(startDate.getMonth() / 3);
  const current = new Date(startDate.getFullYear(), startQuarter * 3, 1);
  const now = new Date();
  const currentQuarter = Math.floor(now.getMonth() / 3);
  const currentYear = now.getFullYear();

  while (current <= endDate) {
    const year = current.getFullYear();
    const quarter = Math.floor(current.getMonth() / 3);

    const quarterStart = new Date(year, quarter * 3, 1);
    const quarterEnd = new Date(year, quarter * 3 + 3, 0, 23, 59, 59, 999);

    const isCurrentPeriod = year === currentYear && quarter === currentQuarter;

    columns.push({
      label: `Q${quarter + 1} ${year}`,
      startDate: quarterStart,
      endDate: quarterEnd,
      isCurrentPeriod,
    });

    current.setMonth(current.getMonth() + 3);
  }

  return columns;
}

export function isDateInColumn(
  targetDate: string,
  column: TimelineColumn,
): boolean {
  const clean = extractYmdDate(targetDate);
  if (!clean) return false;
  const date = parseLocalYmd(clean);
  return date >= column.startDate && date <= column.endDate;
}

export function prepareRoadmapItems(
  workItems: WorkItem[],
  includeTypes: ('Epic' | 'Feature')[],
): RoadmapItem[] {
  return workItems
    .filter(
      (item) =>
        includeTypes.includes(item.workItemType as 'Epic' | 'Feature') &&
        Boolean(item.targetDate),
    )
    .map((item) => {
      const completionPercentage = 0;
      const timeElapsedPercentage = calculateTimeElapsed(
        item.createdDate,
        item.targetDate!,
      );
      const daysRemaining = calculateDaysRemaining(item.targetDate!);

      return {
        id: item.id,
        title: item.title,
        workItemType: item.workItemType,
        targetDate: item.targetDate!,
        assignedTo: item.assignedTo,
        state: item.state,
        createdDate: item.createdDate,
        completionPercentage,
        childCount: 0,
        completedCount: 0,
        greenCount: 0,
        amberCount: 0,
        redCount: 0,
        healthStatus: calculateHealthStatus(
          completionPercentage,
          timeElapsedPercentage,
          daysRemaining,
          0,
        ),
        daysRemaining,
        timeElapsedPercentage,
        children: [],
      };
    })
    .sort(
      (a, b) =>
        new Date(a.targetDate).getTime() - new Date(b.targetDate).getTime(),
    );
}

export function getHealthStatusColor(
  status: WorkbenchHealthStatus,
): string {
  const colors: Record<WorkbenchHealthStatus, string> = {
    'on-track': 'var(--success-color)',
    ahead: 'var(--accent-color)',
    'in-progress': 'var(--warning-color)',
    behind: 'var(--error-color)',
    unscheduled: 'var(--text-muted)',
  };
  return colors[status];
}

export function getHealthStatusLabel(
  status: WorkbenchHealthStatus,
): string {
  const labels: Record<WorkbenchHealthStatus, string> = {
    'on-track': 'On Track',
    ahead: 'Ahead',
    'in-progress': 'Pacing Risk',
    behind: 'Behind',
    unscheduled: 'No Target Date',
  };
  return labels[status];
}
