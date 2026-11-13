import React, { useCallback, useMemo, useState } from 'react';
import {
  ROADMAP_CHANGE_REASONS,
  ROADMAP_HORIZONS,
  type CreateRoadmapAdhocIdeaInput,
  type RoadmapChangeEventKind,
  type RoadmapHorizon,
  type RoadmapPromoteTarget,
  type UpdateRoadmapAdhocIdeaInput,
  type UpsertRoadmapOverlayInput,
} from '../../shared/types/roadmap';
import type { WorkItem } from '../types/workitem';
import {
  useCreateRoadmapIdea,
  useDeleteRoadmapIdea,
  useEpicChildrenMap,
  useProjectRoadmap,
  usePromoteRoadmapIdea,
  useUpdateRoadmapIdea,
  useUpdateRoadmapSettings,
  useUpsertRoadmapOverlay,
} from '../hooks/useProjectRoadmap';
import {
  buildWorkbenchItems,
  calculateRoadmapDriftKpis,
  computeTimelineBarGeometry,
  computeTodayMarkerPercent,
  extractYmdDate,
  formatShortDate,
  generateMonthlyTimeline,
  generateQuarterlyTimeline,
  getHealthStatusColor,
  getHealthStatusLabel,
  getHorizonLabel,
  getOriginLabel,
  getScheduleSourceLabel,
  shiftIsoDate,
  type RoadmapWorkbenchItem,
} from '../utils/roadmapUtils';
import { RoadmapInspectorPanel } from './RoadmapInspectorPanel';
import { RoadmapNewIdeaModal } from './RoadmapNewIdeaModal';
import styles from './RoadmapView.module.css';

export interface RoadmapViewProps {
  workItems: WorkItem[];
  project: string;
  areaPath: string;
  usesBoardWorkItems?: boolean;
  onSelectItem?: (workItem: WorkItem) => void;
  onUpdateField?: (id: number, field: string, value: unknown) => void;
}

type RoadmapViewMode = 'horizons' | 'timeline' | 'sheet' | 'history';
type TimelineGranularity = 'monthly' | 'quarterly';
type TimelineGroupBy = 'hierarchy' | 'horizon' | 'owner' | 'health';

const STATUS_FILTER_OPTIONS = [
  'New',
  'Active',
  'In Progress',
  'In Design',
  'Done',
  'Closed',
] as const;

const HORIZON_CAPTIONS: Record<RoadmapHorizon, string> = {
  now: 'Active execution & immediate focus',
  next: 'Committed next horizon',
  later: 'Strategic / >60d horizon',
  unplanned: 'Undated & awaiting horizon placement',
};

const EVENT_KIND_LABELS: Record<RoadmapChangeEventKind, string> = {
  idea_created: 'Idea Created',
  baseline_locked: 'Baseline Locked',
  date_changed: 'Target Moved',
  horizon_changed: 'Horizon Moved',
  idea_promoted: 'Idea Promoted',
};

export const RoadmapView: React.FC<RoadmapViewProps> = ({
  workItems,
  project,
  areaPath,
  usesBoardWorkItems = false,
  onSelectItem,
  onUpdateField,
}) => {
  const [viewMode, setViewMode] = useState<RoadmapViewMode>('horizons');
  const [granularity, setGranularity] =
    useState<TimelineGranularity>('monthly');
  const [timelineMonths, setTimelineMonths] = useState<number>(6);
  const [groupBy, setGroupBy] = useState<TimelineGroupBy>('hierarchy');
  const [showBaselineGhosts, setShowBaselineGhosts] = useState<boolean>(true);
  const [showAdhocIdeas, setShowAdhocIdeas] = useState<boolean>(true);
  const [showInfoPanel, setShowInfoPanel] = useState<boolean>(false);
  const [isNewIdeaOpen, setIsNewIdeaOpen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [historySearch, setHistorySearch] = useState<string>('');
  const [historyReasonFilter, setHistoryReasonFilter] = useState<string>('all');
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(
    () => new Set(['New', 'Active', 'In Progress', 'In Design']),
  );
  const [selectedItemKey, setSelectedItemKey] = useState<string | null>(null);
  const [expandedEpicIds, setExpandedEpicIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [mutationError, setMutationError] = useState<string | null>(null);

  const epicIdsForFetch = workItems
    .filter(
      (wi) => wi.workItemType === 'Epic' && !wi.tags?.includes('ReleaseVersion'),
    )
    .map((wi) => wi.id);

  const roadmapQuery = useProjectRoadmap(project);
  const updateSettingsMutation = useUpdateRoadmapSettings(project);
  const upsertOverlayMutation = useUpsertRoadmapOverlay(project);
  const createIdeaMutation = useCreateRoadmapIdea(project);
  const updateIdeaMutation = useUpdateRoadmapIdea(project);
  const deleteIdeaMutation = useDeleteRoadmapIdea(project);
  const promoteIdeaMutation = usePromoteRoadmapIdea(project);
  const { childrenByEpicId } = useEpicChildrenMap(
    project,
    areaPath,
    epicIdsForFetch,
    !usesBoardWorkItems,
  );

  const overlays = useMemo(
    () => roadmapQuery.data?.overlays ?? [],
    [roadmapQuery.data?.overlays],
  );
  const ideas = useMemo(
    () => roadmapQuery.data?.ideas ?? [],
    [roadmapQuery.data?.ideas],
  );
  const events = useMemo(
    () => roadmapQuery.data?.events ?? [],
    [roadmapQuery.data?.events],
  );
  const syncDatesToAdo = roadmapQuery.data?.settings.syncDatesToAdo ?? false;

  const timelineColumns = useMemo(() => {
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endDate = new Date(
      now.getFullYear(),
      now.getMonth() + timelineMonths,
      0,
    );
    return granularity === 'quarterly'
      ? generateQuarterlyTimeline(startDate, endDate)
      : generateMonthlyTimeline(startDate, endDate);
  }, [granularity, timelineMonths]);

  const todayMarkerPct = useMemo(
    () => computeTodayMarkerPercent(timelineColumns),
    [timelineColumns],
  );

  const workbenchItems = useMemo(
    () =>
      buildWorkbenchItems({
        workItems,
        overlays,
        ideas,
        childrenByEpicId,
        selectedStatuses,
        showAdhocIdeas,
        searchQuery,
        usesBoardWorkItems,
      }),
    [
      childrenByEpicId,
      ideas,
      overlays,
      searchQuery,
      selectedStatuses,
      showAdhocIdeas,
      usesBoardWorkItems,
      workItems,
    ],
  );

  const selectedItem = useMemo(
    () =>
      selectedItemKey
        ? (workbenchItems.find((item) => item.key === selectedItemKey) ?? null)
        : null,
    [selectedItemKey, workbenchItems],
  );

  const itemsByHorizon = useMemo(() => {
    const grouped: Record<RoadmapHorizon, RoadmapWorkbenchItem[]> = {
      now: [],
      next: [],
      later: [],
      unplanned: [],
    };
    for (const item of workbenchItems) {
      grouped[item.horizon].push(item);
    }
    return grouped;
  }, [workbenchItems]);

  const datedTimelineItems = useMemo(
    () => workbenchItems.filter((item) => Boolean(item.effectiveTargetDate)),
    [workbenchItems],
  );

  const unscheduledTimelineItems = useMemo(
    () => workbenchItems.filter((item) => !item.effectiveTargetDate),
    [workbenchItems],
  );

  const swimlaneGroups = useMemo(() => {
    if (groupBy === 'hierarchy') {
      return [{ label: '', items: datedTimelineItems }];
    }
    const groupsMap = new Map<string, RoadmapWorkbenchItem[]>();
    for (const item of datedTimelineItems) {
      let groupKey: string;
      if (groupBy === 'horizon') {
        groupKey = getHorizonLabel(item.horizon);
      } else if (groupBy === 'owner') {
        groupKey = item.ownerLabel;
      } else {
        groupKey = getHealthStatusLabel(item.healthStatus);
      }
      const list = groupsMap.get(groupKey) ?? [];
      list.push(item);
      groupsMap.set(groupKey, list);
    }
    return Array.from(groupsMap.entries()).map(([label, items]) => ({
      label,
      items,
    }));
  }, [datedTimelineItems, groupBy]);

  const driftKpis = useMemo(
    () => calculateRoadmapDriftKpis(workbenchItems, events),
    [events, workbenchItems],
  );

  const filteredEvents = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    return events.filter((ev) => {
      if (historyReasonFilter !== 'all' && ev.reason !== historyReasonFilter) {
        return false;
      }
      if (!q) return true;
      return (
        ev.itemTitle.toLowerCase().includes(q) ||
        ev.actorName.toLowerCase().includes(q) ||
        ev.reason.toLowerCase().includes(q) ||
        (ev.note ?? '').toLowerCase().includes(q)
      );
    });
  }, [events, historyReasonFilter, historySearch]);

  const toggleStatusFilter = useCallback((status: string) => {
    setSelectedStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) {
        next.delete(status);
      } else {
        next.add(status);
      }
      return next;
    });
  }, []);

  const toggleExpandedEpic = useCallback((epicId: number) => {
    setExpandedEpicIds((prev) => {
      const next = new Set(prev);
      if (next.has(epicId)) {
        next.delete(epicId);
      } else {
        next.add(epicId);
      }
      return next;
    });
  }, []);

  const handleSaveOverlay = useCallback(
    async (workItemId: number, payload: UpsertRoadmapOverlayInput) => {
      setMutationError(null);
      try {
        const result = await upsertOverlayMutation.mutateAsync({
          workItemId,
          ...payload,
          areaPath,
        });
        if (
          result.syncedToAdo &&
          onUpdateField &&
          payload.plannedTargetDate !== undefined
        ) {
          onUpdateField(workItemId, 'targetDate', payload.plannedTargetDate);
        }
      } catch (err) {
        setMutationError(
          err instanceof Error ? err.message : 'Failed to save roadmap changes',
        );
      }
    },
    [areaPath, onUpdateField, upsertOverlayMutation],
  );

  const handleSaveIdea = useCallback(
    async (ideaId: string, payload: UpdateRoadmapAdhocIdeaInput) => {
      setMutationError(null);
      try {
        await updateIdeaMutation.mutateAsync({ ideaId, ...payload });
      } catch (err) {
        setMutationError(
          err instanceof Error ? err.message : 'Failed to update idea',
        );
      }
    },
    [updateIdeaMutation],
  );

  const handleCreateIdea = useCallback(
    async (input: CreateRoadmapAdhocIdeaInput) => {
      setMutationError(null);
      try {
        const created = await createIdeaMutation.mutateAsync(input);
        setIsNewIdeaOpen(false);
        setSelectedItemKey(`idea-${created.idea.id}`);
      } catch (err) {
        setMutationError(
          err instanceof Error ? err.message : 'Failed to create idea',
        );
        throw err;
      }
    },
    [createIdeaMutation],
  );

  const handlePromoteIdea = useCallback(
    async (ideaId: string, target: RoadmapPromoteTarget) => {
      setMutationError(null);
      try {
        await promoteIdeaMutation.mutateAsync({
          ideaId,
          target,
          areaPath,
        });
      } catch (err) {
        setMutationError(
          err instanceof Error ? err.message : 'Failed to promote idea',
        );
      }
    },
    [areaPath, promoteIdeaMutation],
  );

  const handleArchiveIdea = useCallback(
    async (ideaId: string) => {
      setMutationError(null);
      try {
        await deleteIdeaMutation.mutateAsync(ideaId);
        setSelectedItemKey((prev) =>
          prev === `idea-${ideaId}` ? null : prev,
        );
      } catch (err) {
        setMutationError(
          err instanceof Error ? err.message : 'Failed to archive idea',
        );
      }
    },
    [deleteIdeaMutation],
  );

  const handleQuickMoveHorizon = useCallback(
    async (item: RoadmapWorkbenchItem, targetHorizon: RoadmapHorizon) => {
      if (item.horizon === targetHorizon) return;
      if (item.kind === 'work-item' && item.workItemId !== undefined) {
        await handleSaveOverlay(item.workItemId, {
          workItemType: item.workItemType,
          horizon: targetHorizon,
          itemTitle: item.title,
          itemOrigin: item.origin === 'board' ? 'board' : 'ado',
          reason: 'Horizon Re-prioritized',
          note: `Moved from ${getHorizonLabel(item.horizon)} to ${getHorizonLabel(targetHorizon)}`,
        });
      } else if (item.kind === 'adhoc-idea' && item.ideaId) {
        await handleSaveIdea(item.ideaId, {
          horizon: targetHorizon,
          reason: 'Horizon Re-prioritized',
          note: `Moved from ${getHorizonLabel(item.horizon)} to ${getHorizonLabel(targetHorizon)}`,
        });
      }
    },
    [handleSaveIdea, handleSaveOverlay],
  );

  const handleQuickShiftDays = useCallback(
    async (item: RoadmapWorkbenchItem, days: number) => {
      const nextTarget = shiftIsoDate(item.effectiveTargetDate, { days });
      const reason = item.baselineTargetDate
        ? 'Estimate Refined'
        : 'Initial Baseline';
      if (item.kind === 'work-item' && item.workItemId !== undefined) {
        await handleSaveOverlay(item.workItemId, {
          workItemType: item.workItemType,
          plannedTargetDate: nextTarget,
          itemTitle: item.title,
          itemOrigin: item.origin === 'board' ? 'board' : 'ado',
          reason,
          note: `Quick-shifted target date by +${days}d`,
        });
      } else if (item.kind === 'adhoc-idea' && item.ideaId) {
        await handleSaveIdea(item.ideaId, {
          plannedTargetDate: nextTarget,
          reason,
          note: `Quick-shifted target date by +${days}d`,
        });
      }
    },
    [handleSaveIdea, handleSaveOverlay],
  );

  const handleToggleAdoSync = useCallback(async () => {
    setMutationError(null);
    try {
      await updateSettingsMutation.mutateAsync({
        syncDatesToAdo: !syncDatesToAdo,
      });
    } catch (err) {
      setMutationError(
        err instanceof Error
          ? err.message
          : 'Failed to update Azure DevOps sync preference',
      );
    }
  }, [syncDatesToAdo, updateSettingsMutation]);

  const isMutating =
    upsertOverlayMutation.isPending ||
    updateIdeaMutation.isPending ||
    deleteIdeaMutation.isPending;

  return (
    <div className={styles.workbench} data-testid="roadmap-workbench">
      {/* ── Top Header ─────────────────────────────────────────────── */}
      <div className={styles.topBar}>
        <div className={styles.titleGroup}>
          <div className={styles.titleRow}>
            <h2 className={styles.heading}>Living Roadmap</h2>
            <span className={styles.projectPill}>{project}</span>
          </div>
          <p className={styles.subtitle}>
            Process-agnostic horizon planning, optional Apex target dates with
            locked baselines, sandbox ideas, and an immutable drift ledger.
          </p>
        </div>

        <div className={styles.headerActions}>
          {!usesBoardWorkItems && (
            <button
              type="button"
              className={`${styles.togglePill} ${
                syncDatesToAdo ? styles.togglePillActive : ''
              }`}
              aria-pressed={syncDatesToAdo}
              onClick={() => void handleToggleAdoSync()}
              disabled={updateSettingsMutation.isPending}
              data-testid="roadmap-sync-ado-toggle"
              title="When enabled, Apex planned target date edits also write Microsoft.VSTS.Scheduling.TargetDate and System.History to Azure DevOps"
            >
              {syncDatesToAdo
                ? 'ADO TargetDate Sync: ON'
                : 'ADO TargetDate Sync: OFF'}
            </button>
          )}

          <button
            type="button"
            className={styles.infoToggleBtn}
            aria-expanded={showInfoPanel}
            onClick={() => setShowInfoPanel((prev) => !prev)}
            data-testid="roadmap-how-it-works-btn"
          >
            How It Works
          </button>

          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => setIsNewIdeaOpen(true)}
            data-testid="roadmap-new-idea-btn"
          >
            + New Ad-hoc Idea
          </button>
        </div>
      </div>

      {showInfoPanel && (
        <div className={styles.infoDrawer}>
          <div className={styles.infoCard}>
            <h3 className={styles.infoCardTitle}>
              Zero ADO TargetDate Required
            </h3>
            <p className={styles.infoCardText}>
              Epics without Azure DevOps target dates appear immediately in{' '}
              <strong>Now / Next / Later / Unplanned</strong> horizons. Dates
              resolve in 4 tiers: Apex Plan → ADO TargetDate → Inferred Child
              Dates → Horizon Only.
            </p>
          </div>
          <div className={styles.infoCard}>
            <h3 className={styles.infoCardTitle}>
              Locked Baselines &amp; Slip Ghosts
            </h3>
            <p className={styles.infoCardText}>
              Setting an Apex target date automatically locks the original
              baseline. Subsequent shifts preserve the baseline ghost bar and
              record the reason and slip delta in PostgreSQL.
            </p>
          </div>
          <div className={styles.infoCard}>
            <h3 className={styles.infoCardTitle}>
              Sandbox Ideas → Formal Delivery
            </h3>
            <p className={styles.infoCardText}>
              Capture early PO/BA ideas directly on the roadmap instead of side
              Excel sheets, then promote them into Apex Feature Requests or ADO
              Epics with full audit history intact.
            </p>
          </div>
        </div>
      )}

      {mutationError && (
        <div className={styles.bannerError} role="alert">
          {mutationError}
        </div>
      )}

      {/* ── Mode Switcher & Search / Idea Filter ───────────────────── */}
      <div className={styles.modeAndFilterBar}>
        <div className={styles.modeTabs} role="tablist" aria-label="Roadmap views">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'horizons'}
            className={`${styles.modeTab} ${
              viewMode === 'horizons' ? styles.modeTabActive : ''
            }`}
            onClick={() => setViewMode('horizons')}
            data-testid="roadmap-mode-horizons"
          >
            Horizon Board
            <span className={styles.modeCount}>{workbenchItems.length}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'timeline'}
            className={`${styles.modeTab} ${
              viewMode === 'timeline' ? styles.modeTabActive : ''
            }`}
            onClick={() => setViewMode('timeline')}
            data-testid="roadmap-mode-timeline"
          >
            Living Timeline
            <span className={styles.modeCount}>
              {datedTimelineItems.length}
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'sheet'}
            className={`${styles.modeTab} ${
              viewMode === 'sheet' ? styles.modeTabActive : ''
            }`}
            onClick={() => setViewMode('sheet')}
            data-testid="roadmap-mode-sheet"
          >
            Planning Sheet
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'history'}
            className={`${styles.modeTab} ${
              viewMode === 'history' ? styles.modeTabActive : ''
            }`}
            onClick={() => setViewMode('history')}
            data-testid="roadmap-mode-history"
          >
            Drift &amp; History
            <span className={styles.modeCount}>{events.length}</span>
          </button>
        </div>

        <div className={styles.toolbarControls}>
          <input
            type="search"
            aria-label="Search roadmap items"
            className={styles.searchInput}
            placeholder="Search epics, owners, or ideas…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="roadmap-search-input"
          />

          <button
            type="button"
            className={`${styles.togglePill} ${
              showAdhocIdeas ? styles.togglePillActive : ''
            }`}
            aria-pressed={showAdhocIdeas}
            onClick={() => setShowAdhocIdeas((prev) => !prev)}
            data-testid="roadmap-toggle-adhoc"
          >
            {showAdhocIdeas ? '✓ Show Ad-hoc Ideas' : 'Show Ad-hoc Ideas'}
          </button>
        </div>
      </div>

      {viewMode !== 'history' && (
        <div className={styles.filterRow}>
          <div className={styles.statusPills}>
            <span className={styles.filterLabel}>Epic States:</span>
            {STATUS_FILTER_OPTIONS.map((status) => {
              const active = selectedStatuses.has(status);
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={active}
                  className={`${styles.statusPill} ${
                    active ? styles.statusPillSelected : ''
                  }`}
                  onClick={() => toggleStatusFilter(status)}
                  data-testid={`roadmap-status-filter-${status.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  {status}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Main Content + Inline Roadmap Inspector Split ──────────── */}
      <div
        className={`${styles.workspaceSplit} ${
          selectedItem ? styles.workspaceSplitWithInspector : ''
        }`}
      >
        <div>
          {/* ── VIEW 1: HORIZON BOARD ──────────────────────────────── */}
          {viewMode === 'horizons' && (
            <div className={styles.horizonGrid}>
              {ROADMAP_HORIZONS.map((horizon) => {
                const colItems = itemsByHorizon[horizon];
                return (
                  <section
                    key={horizon}
                    className={styles.horizonColumn}
                    aria-label={`${getHorizonLabel(horizon)} horizon`}
                    data-testid={`roadmap-horizon-col-${horizon}`}
                  >
                    <div className={styles.horizonColHeader}>
                      <div className={styles.horizonTitleGroup}>
                        <h3 className={styles.horizonName}>
                          {getHorizonLabel(horizon)}
                        </h3>
                        <span className={styles.horizonCaption}>
                          {HORIZON_CAPTIONS[horizon]}
                        </span>
                      </div>
                      <span className={styles.countBadge}>
                        {colItems.length}
                      </span>
                    </div>

                    <div className={styles.horizonCardList}>
                      {colItems.length === 0 ? (
                        <div className={styles.emptyColumn}>
                          No items in {getHorizonLabel(horizon)}
                        </div>
                      ) : (
                        colItems.map((item) => {
                          const isSelected = selectedItem?.key === item.key;
                          const quickTargets = (
                            ['now', 'next', 'later'] as RoadmapHorizon[]
                          ).filter((h) => h !== item.horizon);

                          return (
                            <article
                              key={item.key}
                              className={`${styles.itemCard} ${
                                isSelected ? styles.itemCardSelected : ''
                              }`}
                              data-testid={
                                item.kind === 'work-item'
                                  ? `roadmap-card-wi-${item.workItemId}`
                                  : `roadmap-card-idea-${item.ideaId}`
                              }
                            >
                              <div className={styles.cardTopRow}>
                                <div className={styles.badgeRow}>
                                  <span
                                    className={`${styles.originBadge} ${
                                      item.origin === 'adhoc'
                                        ? styles.originAdhoc
                                        : ''
                                    }`}
                                  >
                                    {getOriginLabel(item.origin)}
                                    {item.workItemId
                                      ? ` #${item.workItemId}`
                                      : ''}
                                  </span>

                                  {item.isCompleted && (
                                    <span className={styles.doneBadge}>
                                      Done
                                    </span>
                                  )}

                                  {item.effortSize && (
                                    <span className={styles.effortBadge}>
                                      {item.effortSize}
                                    </span>
                                  )}

                                  {item.promotedFeatureRequestId && (
                                    <span className={styles.promotedBadge}>
                                      Promoted · Feature Request
                                    </span>
                                  )}

                                  {item.promotedAdoWorkItemId && (
                                    <span className={styles.promotedBadge}>
                                      Promoted · Epic #
                                      {item.promotedAdoWorkItemId}
                                    </span>
                                  )}
                                </div>
                              </div>

                              <button
                                type="button"
                                className={styles.cardTitleBtn}
                                onClick={() => setSelectedItemKey(item.key)}
                                data-testid={`roadmap-card-title-${item.key}`}
                              >
                                {item.title}
                              </button>

                              <div className={styles.cardMetaRow}>
                                <span>{item.ownerLabel}</span>
                                <span>{item.state}</span>
                              </div>

                              <div className={styles.cardMetaRow}>
                                <span
                                  className={`${styles.sourcePill} ${
                                    item.scheduleSource === 'apex-plan'
                                      ? styles.sourcePillApex
                                      : ''
                                  }`}
                                >
                                  {getScheduleSourceLabel(item.scheduleSource)}
                                  {item.effectiveTargetDate
                                    ? ` · ${formatShortDate(item.effectiveTargetDate)}`
                                    : ''}
                                </span>

                                {item.slipDays !== null && item.slipDays > 0 && (
                                  <span
                                    className={`${styles.slipBadge} ${styles.slipLate}`}
                                  >
                                    +{item.slipDays}d
                                  </span>
                                )}
                                {item.slipDays === 0 &&
                                  item.baselineTargetDate && (
                                    <span
                                      className={`${styles.slipBadge} ${styles.slipOnTime}`}
                                    >
                                      On baseline
                                    </span>
                                  )}
                              </div>

                              {item.kind === 'work-item' &&
                                item.weightedProgress.totalCount > 0 && (
                                  <div className={styles.progressWrap}>
                                    <div
                                      className={styles.progressTrack}
                                      role="progressbar"
                                      aria-valuemin={0}
                                      aria-valuemax={100}
                                      aria-valuenow={item.completionPercentage}
                                      aria-label={`${item.title} weighted progress`}
                                    >
                                      <div
                                        className={styles.segDone}
                                        style={{
                                          width: `${item.weightedProgress.donePct}%`,
                                        }}
                                        title={`Done: ${item.weightedProgress.doneCount}`}
                                      />
                                      <div
                                        className={styles.segUat}
                                        style={{
                                          width: `${item.weightedProgress.uatPct}%`,
                                        }}
                                        title={`UAT: ${item.weightedProgress.uatCount}`}
                                      />
                                      <div
                                        className={styles.segInProgress}
                                        style={{
                                          width: `${item.weightedProgress.inProgressPct}%`,
                                        }}
                                        title={`In Progress: ${item.weightedProgress.inProgressCount}`}
                                      />
                                      <div
                                        className={styles.segTodo}
                                        style={{
                                          width: `${item.weightedProgress.todoPct}%`,
                                        }}
                                        title={`Todo: ${item.weightedProgress.todoCount}`}
                                      />
                                    </div>
                                    <div className={styles.progressMeta}>
                                      <span>
                                        {item.completionPercentage}% weighted
                                      </span>
                                      <span>
                                        {item.weightedProgress.doneCount}/
                                        {item.weightedProgress.totalCount} done
                                      </span>
                                    </div>
                                  </div>
                                )}

                              {item.notes && (
                                <p className={styles.cardNotesPreview}>
                                  {item.notes}
                                </p>
                              )}

                              <div className={styles.quickActionsRow}>
                                {quickTargets.slice(0, 2).map((targetH) => (
                                  <button
                                    key={targetH}
                                    type="button"
                                    className={styles.miniActionBtn}
                                    disabled={isMutating}
                                    onClick={() =>
                                      void handleQuickMoveHorizon(item, targetH)
                                    }
                                    data-testid={`roadmap-card-move-${item.key}-${targetH}`}
                                  >
                                    → {getHorizonLabel(targetH)}
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className={styles.miniActionBtn}
                                  onClick={() => setSelectedItemKey(item.key)}
                                  data-testid={`roadmap-card-inspect-${item.key}`}
                                >
                                  Inspect
                                </button>
                              </div>
                            </article>
                          );
                        })
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}

          {/* ── VIEW 2: LIVING TIMELINE (GANTT + GHOSTS + TRAY) ─────── */}
          {viewMode === 'timeline' && (
            <div className={styles.timelineShell}>
              <div className={styles.timelineToolbar}>
                <div className={styles.inlineControlGroup}>
                  <label
                    htmlFor="roadmap-timeline-granularity"
                    className={styles.controlField}
                  >
                    <span>Scale:</span>
                    <select
                      id="roadmap-timeline-granularity"
                      className={styles.selectInput}
                      value={granularity}
                      onChange={(e) =>
                        setGranularity(e.target.value as TimelineGranularity)
                      }
                      data-testid="roadmap-timeline-granularity"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                    </select>
                  </label>

                  <label
                    htmlFor="roadmap-timeline-months"
                    className={styles.controlField}
                  >
                    <span>Window:</span>
                    <select
                      id="roadmap-timeline-months"
                      className={styles.selectInput}
                      value={timelineMonths}
                      onChange={(e) =>
                        setTimelineMonths(Number(e.target.value))
                      }
                      data-testid="roadmap-timeline-months"
                    >
                      <option value={3}>3 Months</option>
                      <option value={6}>6 Months</option>
                      <option value={12}>12 Months</option>
                    </select>
                  </label>

                  <label
                    htmlFor="roadmap-timeline-groupby"
                    className={styles.controlField}
                  >
                    <span>Group By:</span>
                    <select
                      id="roadmap-timeline-groupby"
                      className={styles.selectInput}
                      value={groupBy}
                      onChange={(e) =>
                        setGroupBy(e.target.value as TimelineGroupBy)
                      }
                      data-testid="roadmap-timeline-groupby"
                    >
                      <option value="hierarchy">Hierarchy</option>
                      <option value="horizon">Horizon</option>
                      <option value="owner">Owner</option>
                      <option value="health">Health</option>
                    </select>
                  </label>
                </div>

                <div className={styles.inlineControlGroup}>
                  <button
                    type="button"
                    className={`${styles.togglePill} ${
                      showBaselineGhosts ? styles.togglePillActive : ''
                    }`}
                    aria-pressed={showBaselineGhosts}
                    onClick={() => setShowBaselineGhosts((prev) => !prev)}
                    data-testid="roadmap-toggle-ghosts"
                  >
                    {showBaselineGhosts
                      ? '✓ Baseline Ghosts'
                      : 'Baseline Ghosts'}
                  </button>
                </div>
              </div>

              <div
                className={styles.ganttCard}
                style={
                  {
                    '--col-count': timelineColumns.length,
                  } as React.CSSProperties
                }
              >
                <div className={styles.ganttMinWidth}>
                  <div className={styles.ganttHeaderRow}>
                    <div className={styles.ganttLabelHeader}>
                      Roadmap Item ({datedTimelineItems.length} scheduled)
                    </div>
                    <div className={styles.ganttColumnsHeader}>
                      {timelineColumns.map((col) => (
                        <div
                          key={col.label}
                          className={`${styles.ganttColCell} ${
                            col.isCurrentPeriod
                              ? styles.ganttColCellCurrent
                              : ''
                          }`}
                        >
                          {col.label}
                        </div>
                      ))}
                      {todayMarkerPct !== null && (
                        <div
                          className={styles.todayMarkerTag}
                          style={{ left: `${todayMarkerPct}%` }}
                          data-testid="roadmap-today-marker"
                        >
                          Today
                        </div>
                      )}
                    </div>
                  </div>

                  {datedTimelineItems.length === 0 ? (
                    <div className={styles.emptyColumn}>
                      No dated items fall on the timeline yet. Select an Epic or
                      Idea below in the Unscheduled Backlog Tray to assign a
                      target date.
                    </div>
                  ) : (
                    swimlaneGroups.map((group) => (
                      <React.Fragment key={group.label || 'default'}>
                        {group.label && (
                          <div className={styles.swimlaneGroupHeader}>
                            {group.label} ({group.items.length})
                          </div>
                        )}
                        {group.items.map((item) => {
                          const barGeometry = computeTimelineBarGeometry(
                            item.effectiveStartDate,
                            item.effectiveTargetDate,
                            timelineColumns,
                          );
                          const hasSlippedBaseline =
                            showBaselineGhosts &&
                            Boolean(item.baselineTargetDate) &&
                            item.baselineTargetDate !==
                              item.effectiveTargetDate;
                          const ghostGeometry = hasSlippedBaseline
                            ? computeTimelineBarGeometry(
                                item.effectiveStartDate,
                                item.baselineTargetDate,
                                timelineColumns,
                              )
                            : null;
                          const isExpanded =
                            item.workItemId !== undefined &&
                            expandedEpicIds.has(item.workItemId);
                          const hasChildren = item.children.length > 0;

                          return (
                            <React.Fragment key={item.key}>
                              <div
                                className={styles.ganttRow}
                                data-testid={`roadmap-timeline-row-${item.key}`}
                              >
                                <div className={styles.ganttRowLabel}>
                                  {groupBy === 'hierarchy' &&
                                  item.workItemId !== undefined &&
                                  hasChildren ? (
                                    <button
                                      type="button"
                                      className={styles.expandBtn}
                                      aria-expanded={isExpanded}
                                      aria-label={`Toggle children for ${item.title}`}
                                      onClick={() =>
                                        toggleExpandedEpic(item.workItemId!)
                                      }
                                      data-testid={`roadmap-timeline-expand-${item.key}`}
                                    >
                                      {isExpanded ? '▼' : '▶'}
                                    </button>
                                  ) : (
                                    <span className={styles.expandSpacer} />
                                  )}

                                  <div className={styles.ganttTitleBlock}>
                                    <button
                                      type="button"
                                      className={styles.ganttTitleBtn}
                                      onClick={() =>
                                        setSelectedItemKey(item.key)
                                      }
                                      title={item.title}
                                      data-testid={`roadmap-timeline-title-${item.key}`}
                                    >
                                      {item.title}
                                    </button>
                                    <span className={styles.ganttSubMeta}>
                                      {getOriginLabel(item.origin)} ·{' '}
                                      {getHorizonLabel(item.horizon)} ·{' '}
                                      {item.ownerLabel}
                                    </span>
                                  </div>
                                </div>

                                <div className={styles.ganttTrack}>
                                  {timelineColumns.map((col) => (
                                    <div
                                      key={col.label}
                                      className={`${styles.ganttGridBgCell} ${
                                        col.isCurrentPeriod
                                          ? styles.ganttGridBgCellCurrent
                                          : ''
                                      }`}
                                    />
                                  ))}

                                  {todayMarkerPct !== null && (
                                    <div
                                      className={styles.todayMarkerLine}
                                      style={{ left: `${todayMarkerPct}%` }}
                                    />
                                  )}

                                  {ghostGeometry && (
                                    <div
                                      className={styles.baselineGhostBar}
                                      style={{
                                        left: `${ghostGeometry.leftPct}%`,
                                        width: `${ghostGeometry.widthPct}%`,
                                      }}
                                      title={`Original Baseline: ${formatShortDate(item.baselineTargetDate)}`}
                                      data-testid="roadmap-baseline-ghost"
                                    />
                                  )}

                                  {barGeometry && (
                                    <button
                                      type="button"
                                      className={`${styles.spanBarBtn} ${
                                        !ghostGeometry
                                          ? styles.spanBarCentered
                                          : ''
                                      }`}
                                      style={{
                                        left: `${barGeometry.leftPct}%`,
                                        width: `${barGeometry.widthPct}%`,
                                        borderColor: getHealthStatusColor(
                                          item.healthStatus,
                                        ),
                                      }}
                                      onClick={() =>
                                        setSelectedItemKey(item.key)
                                      }
                                      title={`${item.title} → ${formatShortDate(item.effectiveTargetDate)}`}
                                      data-testid={`roadmap-timeline-bar-${item.key}`}
                                    >
                                      <span>
                                        {formatShortDate(
                                          item.effectiveTargetDate,
                                        )}
                                      </span>
                                      {item.slipDays !== null &&
                                        item.slipDays > 0 && (
                                          <span
                                            className={`${styles.slipBadge} ${styles.slipLate}`}
                                          >
                                            +{item.slipDays}d
                                          </span>
                                        )}
                                    </button>
                                  )}
                                </div>
                              </div>

                              {groupBy === 'hierarchy' &&
                                isExpanded &&
                                item.children.map((child) => {
                                  const childDate =
                                    extractYmdDate(child.targetDate) ??
                                    extractYmdDate(child.dueDate);
                                  const childGeom = computeTimelineBarGeometry(
                                    extractYmdDate(child.createdDate) ??
                                      childDate,
                                    childDate,
                                    timelineColumns,
                                  );

                                  return (
                                    <div
                                      key={`child-${child.id}`}
                                      className={`${styles.ganttRow} ${styles.ganttChildRow}`}
                                    >
                                      <div className={styles.ganttRowLabel}>
                                        <span className={styles.expandSpacer}>
                                          └
                                        </span>
                                        <div className={styles.ganttTitleBlock}>
                                          <button
                                            type="button"
                                            className={styles.ganttTitleBtn}
                                            onClick={() =>
                                              onSelectItem?.(child)
                                            }
                                            data-testid={`roadmap-timeline-child-title-${child.id}`}
                                          >
                                            {child.title}
                                          </button>
                                          <span className={styles.ganttSubMeta}>
                                            {child.workItemType} · {child.state}
                                          </span>
                                        </div>
                                      </div>

                                      <div className={styles.ganttTrack}>
                                        {timelineColumns.map((col) => (
                                          <div
                                            key={col.label}
                                            className={`${styles.ganttGridBgCell} ${
                                              col.isCurrentPeriod
                                                ? styles.ganttGridBgCellCurrent
                                                : ''
                                            }`}
                                          />
                                        ))}
                                        {todayMarkerPct !== null && (
                                          <div
                                            className={styles.todayMarkerLine}
                                            style={{
                                              left: `${todayMarkerPct}%`,
                                            }}
                                          />
                                        )}
                                        {childGeom && (
                                          <button
                                            type="button"
                                            className={`${styles.spanBarBtn} ${styles.spanBarChild}`}
                                            style={{
                                              left: `${childGeom.leftPct}%`,
                                              width: `${childGeom.widthPct}%`,
                                            }}
                                            onClick={() =>
                                              onSelectItem?.(child)
                                            }
                                            data-testid={`roadmap-timeline-child-bar-${child.id}`}
                                          >
                                            <span>
                                              {formatShortDate(childDate)}
                                            </span>
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                            </React.Fragment>
                          );
                        })}
                      </React.Fragment>
                    ))
                  )}
                </div>
              </div>

              {/* ── Unscheduled Backlog Tray ────────────────────────── */}
              <section
                className={styles.unscheduledTray}
                aria-label="Unscheduled Backlog Tray"
                data-testid="roadmap-unscheduled-tray"
              >
                <div className={styles.trayHeader}>
                  <h3 className={styles.trayTitle}>
                    Unscheduled Backlog Tray ({unscheduledTimelineItems.length})
                  </h3>
                  <span className={styles.subtitle}>
                    Undated Epics &amp; Draft Ideas tracked by horizon — inspect
                    any item to lock a planned target date
                  </span>
                </div>

                {unscheduledTimelineItems.length === 0 ? (
                  <div className={styles.infoCardText}>
                    Every visible roadmap item currently has an effective target
                    date.
                  </div>
                ) : (
                  <div className={styles.trayGrid}>
                    {unscheduledTimelineItems.map((item) => (
                      <div key={item.key} className={styles.trayCard}>
                        <div className={styles.ganttTitleBlock}>
                          <button
                            type="button"
                            className={styles.ganttTitleBtn}
                            onClick={() => setSelectedItemKey(item.key)}
                            data-testid={`roadmap-tray-title-${item.key}`}
                          >
                            {item.title}
                          </button>
                          <span className={styles.ganttSubMeta}>
                            {getOriginLabel(item.origin)} ·{' '}
                            {getHorizonLabel(item.horizon)} · {item.ownerLabel}
                          </span>
                        </div>
                        <button
                          type="button"
                          className={styles.miniActionBtn}
                          onClick={() => setSelectedItemKey(item.key)}
                          data-testid={`roadmap-tray-schedule-${item.key}`}
                        >
                          Schedule
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ── VIEW 3: PLANNING SHEET (EXCEL-STYLE GRID) ───────────── */}
          {viewMode === 'sheet' && (
            <div className={styles.tableCard}>
              <table
                className={styles.sheetTable}
                data-testid="roadmap-sheet-table"
              >
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Origin</th>
                    <th>Horizon</th>
                    <th>Schedule Source</th>
                    <th>Owner</th>
                    <th>Progress / Size</th>
                    <th>Baseline Date</th>
                    <th>Current Target</th>
                    <th>Slip</th>
                    <th>Quick Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {workbenchItems.length === 0 ? (
                    <tr>
                      <td colSpan={10}>
                        No roadmap items match the active filters.
                      </td>
                    </tr>
                  ) : (
                    workbenchItems.map((item) => {
                      const isSelected = selectedItem?.key === item.key;
                      return (
                        <tr
                          key={item.key}
                          className={isSelected ? styles.sheetRowSelected : ''}
                        >
                          <td>
                            <div className={styles.badgeRow}>
                              <button
                                type="button"
                                className={styles.cardTitleBtn}
                                onClick={() => setSelectedItemKey(item.key)}
                                data-testid={`roadmap-sheet-title-${item.key}`}
                              >
                                {item.title}
                              </button>
                              {item.promotedFeatureRequestId && (
                                <span className={styles.promotedBadge}>
                                  Promoted
                                </span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span
                              className={`${styles.originBadge} ${
                                item.origin === 'adhoc'
                                  ? styles.originAdhoc
                                  : ''
                              }`}
                            >
                              {getOriginLabel(item.origin)}
                              {item.workItemId ? ` #${item.workItemId}` : ''}
                            </span>
                          </td>
                          <td>{getHorizonLabel(item.horizon)}</td>
                          <td>
                            <span className={styles.sourcePill}>
                              {getScheduleSourceLabel(item.scheduleSource)}
                            </span>
                          </td>
                          <td>{item.ownerLabel}</td>
                          <td>
                            {item.kind === 'adhoc-idea'
                              ? `Effort: ${item.effortSize ?? 'M'} (${item.confidence ?? 'low'})`
                              : item.weightedProgress.totalCount > 0
                                ? `${item.completionPercentage}% (${item.weightedProgress.doneCount}/${item.weightedProgress.totalCount})`
                                : item.state}
                          </td>
                          <td>{formatShortDate(item.baselineTargetDate)}</td>
                          <td>{formatShortDate(item.effectiveTargetDate)}</td>
                          <td>
                            {item.slipDays !== null && item.slipDays > 0 ? (
                              <span
                                className={`${styles.slipBadge} ${styles.slipLate}`}
                              >
                                +{item.slipDays}d
                              </span>
                            ) : item.slipDays === 0 &&
                              item.baselineTargetDate ? (
                              <span
                                className={`${styles.slipBadge} ${styles.slipOnTime}`}
                              >
                                0d
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <div className={styles.badgeRow}>
                              <button
                                type="button"
                                className={styles.miniActionBtn}
                                disabled={isMutating}
                                onClick={() =>
                                  void handleQuickShiftDays(item, 7)
                                }
                                data-testid={`roadmap-sheet-shift-1w-${item.key}`}
                              >
                                +1w
                              </button>
                              <button
                                type="button"
                                className={styles.miniActionBtn}
                                disabled={isMutating}
                                onClick={() =>
                                  void handleQuickShiftDays(item, 14)
                                }
                                data-testid={`roadmap-sheet-shift-2w-${item.key}`}
                              >
                                +2w
                              </button>
                              {item.horizon !== 'now' && (
                                <button
                                  type="button"
                                  className={styles.miniActionBtn}
                                  disabled={isMutating}
                                  onClick={() =>
                                    void handleQuickMoveHorizon(item, 'now')
                                  }
                                  data-testid={`roadmap-sheet-move-now-${item.key}`}
                                >
                                  → Now
                                </button>
                              )}
                              {item.kind === 'adhoc-idea' &&
                                item.ideaId &&
                                !item.promotedFeatureRequestId && (
                                  <button
                                    type="button"
                                    className={styles.miniActionBtn}
                                    disabled={promoteIdeaMutation.isPending}
                                    onClick={() =>
                                      void handlePromoteIdea(
                                        item.ideaId!,
                                        'feature-request',
                                      )
                                    }
                                    data-testid={`roadmap-sheet-promote-${item.key}`}
                                  >
                                    Promote
                                  </button>
                                )}
                              <button
                                type="button"
                                className={styles.miniActionBtn}
                                onClick={() => setSelectedItemKey(item.key)}
                                data-testid={`roadmap-sheet-inspect-${item.key}`}
                              >
                                Inspect
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* ── VIEW 4: DRIFT & HISTORY LEDGER ──────────────────────── */}
          {viewMode === 'history' && (
            <div className={styles.ledgerShell}>
              <div
                className={styles.kpiStrip}
                data-testid="roadmap-history-kpis"
              >
                <div className={styles.kpiCard}>
                  <span className={styles.kpiLabel}>Active Now / Next</span>
                  <span className={styles.kpiValue}>
                    {driftKpis.activeNowNextCount}
                  </span>
                  <span className={styles.kpiSub}>
                    Committed active &amp; next-horizon items
                  </span>
                </div>

                <div className={styles.kpiCard}>
                  <span className={styles.kpiLabel}>Baseline Adherence</span>
                  <span className={styles.kpiValue}>
                    {driftKpis.baselineAdherencePct}%
                  </span>
                  <span className={styles.kpiSub}>
                    Dated items holding original baseline
                  </span>
                </div>

                <div className={styles.kpiCard}>
                  <span className={styles.kpiLabel}>Avg Slip Days</span>
                  <span className={styles.kpiValue}>
                    {driftKpis.avgSlipDays}d
                  </span>
                  <span className={styles.kpiSub}>
                    Mean slip across delayed baseline items
                  </span>
                </div>

                <div className={styles.kpiCard}>
                  <span className={styles.kpiLabel}>Audited Moves</span>
                  <span className={styles.kpiValue}>
                    {driftKpis.auditedMovesCount}
                  </span>
                  <span className={styles.kpiSub}>
                    Immutable PostgreSQL ledger entries
                  </span>
                </div>
              </div>

              <div className={styles.timelineToolbar}>
                <div className={styles.inlineControlGroup}>
                  <input
                    type="search"
                    aria-label="Search history ledger"
                    className={styles.searchInput}
                    placeholder="Filter history by item, actor, or note…"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                    data-testid="roadmap-history-search"
                  />

                  <label
                    htmlFor="roadmap-history-reason"
                    className={styles.controlField}
                  >
                    <span>Reason:</span>
                    <select
                      id="roadmap-history-reason"
                      className={styles.selectInput}
                      value={historyReasonFilter}
                      onChange={(e) => setHistoryReasonFilter(e.target.value)}
                      data-testid="roadmap-history-reason-filter"
                    >
                      <option value="all">All Reasons</option>
                      {ROADMAP_CHANGE_REASONS.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className={styles.tableCard}>
                <table
                  className={styles.sheetTable}
                  data-testid="roadmap-history-table"
                >
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Item</th>
                      <th>Origin</th>
                      <th>Event</th>
                      <th>Change</th>
                      <th>Delta</th>
                      <th>Reason</th>
                      <th>Note</th>
                      <th>Actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEvents.length === 0 ? (
                      <tr>
                        <td colSpan={9}>
                          No roadmap history events match the current filter.
                        </td>
                      </tr>
                    ) : (
                      filteredEvents.map((ev) => (
                        <tr key={ev.id} data-event-kind={ev.eventKind}>
                          <td>
                            {new Date(ev.createdAt).toLocaleString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>
                            <strong>{ev.itemTitle}</strong>
                          </td>
                          <td>{getOriginLabel(ev.itemOrigin)}</td>
                          <td>
                            <span className={styles.sourcePill}>
                              {EVENT_KIND_LABELS[ev.eventKind]} ({ev.eventKind})
                            </span>
                          </td>
                          <td>
                            {ev.eventKind === 'horizon_changed' &&
                              `${ev.fromHorizon ?? 'auto'} → ${ev.toHorizon ?? 'auto'}`}
                            {ev.eventKind === 'baseline_locked' &&
                              `Baseline → ${formatShortDate(ev.newTargetDate)}`}
                            {ev.eventKind === 'date_changed' &&
                              `${formatShortDate(ev.oldTargetDate)} → ${formatShortDate(ev.newTargetDate)}`}
                            {ev.eventKind === 'idea_created' &&
                              `Created in ${ev.toHorizon ?? 'later'}${
                                ev.newTargetDate
                                  ? ` (${formatShortDate(ev.newTargetDate)})`
                                  : ''
                              }`}
                            {ev.eventKind === 'idea_promoted' &&
                              'Promoted from Draft Idea'}
                          </td>
                          <td>
                            {ev.deltaDays !== null && ev.deltaDays > 0 ? (
                              <span
                                className={`${styles.slipBadge} ${styles.slipLate}`}
                              >
                                +{ev.deltaDays}d
                              </span>
                            ) : ev.deltaDays !== null ? (
                              `${ev.deltaDays}d`
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>{ev.reason}</td>
                          <td>{ev.note ?? '—'}</td>
                          <td>{ev.actorName}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ── Inline Roadmap Inspector ──────────────────────────────── */}
        {selectedItem && (
          // data-testid-exempt — RoadmapInspectorPanel owns data-testid="roadmap-inspector"
          <RoadmapInspectorPanel
            key={`${selectedItem.key}-${selectedItem.effectiveTargetDate ?? ''}-${selectedItem.horizon}-${selectedItem.promotedFeatureRequestId ?? ''}`}
            item={selectedItem}
            events={events}
            isSaving={isMutating}
            isPromoting={promoteIdeaMutation.isPending}
            usesBoardWorkItems={usesBoardWorkItems}
            errorMessage={mutationError}
            onClose={() => setSelectedItemKey(null)}
            onSaveOverlay={handleSaveOverlay}
            onSaveIdea={handleSaveIdea}
            onPromoteIdea={handlePromoteIdea}
            onArchiveIdea={handleArchiveIdea}
            onOpenWorkItemDetails={onSelectItem}
          />
        )}
      </div>

      {/* ── New Ad-hoc Idea Modal ───────────────────────────────────── */}
      {/* data-testid-exempt — RoadmapNewIdeaModal owns data-testid="roadmap-new-idea-modal" */}
      <RoadmapNewIdeaModal
        isOpen={isNewIdeaOpen}
        isSubmitting={createIdeaMutation.isPending}
        errorMessage={mutationError}
        onClose={() => setIsNewIdeaOpen(false)}
        onCreate={handleCreateIdea}
      />
    </div>
  );
};
