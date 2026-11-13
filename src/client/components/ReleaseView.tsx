import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { WorkItem } from '../types/workitem';
import { useDeploymentOutcomes } from '../hooks/useDeploymentOutcomes';
import type { DeploymentResult } from '../../shared/types/deploymentOutcome';
import { DeploymentOutcomeModal } from './DeploymentOutcomeModal';
import { DeploymentOutcomeReport } from './DeploymentOutcomeReport';
import { CreateCabRequestModal } from './CreateCabRequestModal';
import { CabReleaseAssistantPanel } from './CabReleaseAssistantPanel';
import { ReleaseCabRequestAction } from './ReleaseCabRequestAction';
import { ReleaseFormModal, type ReleaseFormValues } from './ReleaseFormModal';
import { useAppShell } from '../hooks/useAppShell';
import { reorderReleases } from '../utils/releaseOrder';
import {
  classifyWorkItemReadiness,
  collectAvailablePlatforms,
  computeReleaseReadiness,
  filterAndSortInspectorItems,
  filterReleaseEpics,
  formatRemainingSummary,
  formatTargetDateCountdown,
  getEpicBucketCounts,
  getEpicPlatform,
  isRenamableStatus,
  sortReleaseEpics,
  type InspectorWorkItemTab,
  type LifecycleScope,
  type ReadinessGapFilter,
  type ReleaseEpic,
  type ReleaseSortBy,
} from '../utils/releaseReadiness';

type WorkItemTabMode = InspectorWorkItemTab;
import {
  defaultPreviousReleaseBranch,
  type CreateCabRequestFormValues,
} from '../utils/cabReleaseKickoff';
import './ReleaseView.css';

const SCROLL_EDGE_PX = 88;

function toSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

function platformToneClass(platform: string): string {
  const lower = platform.toLowerCase();
  if (lower === 'mobile') return 'platform-mobile';
  if (lower === 'desktop') return 'platform-desktop';
  return 'platform-other';
}

function adjustReleaseEpicCounts(epic: ReleaseEpic, item: WorkItem, direction: 1 | -1): ReleaseEpic {
  const bucket = classifyWorkItemReadiness(item);
  const counts = getEpicBucketCounts(epic);
  const totalItems = Math.max(0, counts.total + direction);
  const greenItems = Math.max(0, counts.green + (bucket === 'green' ? direction : 0));
  const amberItems = Math.max(0, counts.amber + (bucket === 'amber' ? direction : 0));
  const redItems = Math.max(0, counts.red + (bucket === 'red' ? direction : 0));
  return {
    ...epic,
    totalItems,
    greenItems,
    amberItems,
    redItems,
    completedItems: greenItems,
    progress: totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0,
  };
}

function findScrollParent(start: HTMLElement | null): HTMLElement | null {
  let el = start;
  while (el) {
    const style = window.getComputedStyle(el);
    const canScroll = /(auto|scroll)/.test(style.overflowY);
    if (canScroll && el.scrollHeight > el.clientHeight + 8) return el;
    el = el.parentElement;
  }
  const doc = document.scrollingElement;
  return doc instanceof HTMLElement ? doc : null;
}

const RESULT_CONFIG: Record<DeploymentResult, { className: string; label: string; icon: string }> = {
  success:  { className: 'result-success',  label: 'Success',  icon: '✓' },
  downtime: { className: 'result-downtime', label: 'Downtime', icon: '⚠' },
  rollback: { className: 'result-rollback', label: 'Rollback', icon: '↩' },
};

const OutcomeBadge: React.FC<{
  releaseVersion: string;
  deployedAt?: string;
  onManage: (releaseVersion: string, deployedAt?: string) => void;
  'data-testid'?: string;
}> = ({ releaseVersion, deployedAt, onManage, 'data-testid': testId }) => {
  const { data: outcomes } = useDeploymentOutcomes(releaseVersion);
  const [showDetails, setShowDetails] = useState(false);
  const outcomeSlug = toSlug(releaseVersion);

  if (!outcomes || outcomes.length === 0) {
    return (
      <button
        type="button"
        className="result-badge result-none result-badge-button"
        {...{ 'data-testid': testId ?? `release-outcome-add-${outcomeSlug}` }}
        onClick={(e) => { e.stopPropagation(); onManage(releaseVersion, deployedAt); }}
        title="Add deployment outcome"
      >
        + Outcome
      </button>
    );
  }

  const latest = outcomes[0];
  const config = RESULT_CONFIG[latest.result];

  return (
    <span style={{ position: 'relative' }} {...(testId ? { 'data-testid': testId } : {})}>
      <button
        type="button"
        className={`result-badge result-badge-button ${config.className}`}
        {...{ 'data-testid': `release-outcome-${outcomeSlug}` }}
        onClick={(e) => { e.stopPropagation(); setShowDetails(!showDetails); }}
        title={`${config.label} – click for details`}
      >
        {config.icon} {config.label}
      </button>
      {showDetails && (
        <div
          className="result-details-popover"
          {...{ 'data-testid': `release-outcome-details-${outcomeSlug}` }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Deployment Outcome</div>
          <div style={{ marginBottom: 4 }}>
            <strong>Result:</strong> {config.icon} {config.label}
          </div>
          {latest.downtimeMinutes != null && latest.downtimeMinutes > 0 && (
            <div style={{ marginBottom: 4 }}>
              <strong>Downtime:</strong> {latest.downtimeMinutes} min
            </div>
          )}
          {latest.details && (
            <div style={{ marginBottom: 4 }}>
              <strong>Details:</strong> {latest.details}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Reported {new Date(latest.reportedAt).toLocaleDateString()}
          </div>
          <button
            type="button"
            className="result-manage-btn"
            {...{ 'data-testid': `release-outcome-manage-${outcomeSlug}` }}
            onClick={(e) => { e.stopPropagation(); onManage(releaseVersion, deployedAt); }}
          >
            Manage outcome
          </button>
        </div>
      )}
    </span>
  );
};

interface ReleaseInspectorOutcomesProps {
  releaseVersion: string;
  onPresenceChange: (hasOutcome: boolean) => void;
}

const ReleaseInspectorOutcomeSync: React.FC<ReleaseInspectorOutcomesProps> = ({
  releaseVersion,
  onPresenceChange,
}) => {
  const { data: outcomes } = useDeploymentOutcomes(releaseVersion);
  useEffect(() => {
    onPresenceChange(Boolean(outcomes && outcomes.length > 0));
  }, [outcomes, onPresenceChange]);
  return null;
};

interface ReleaseViewProps {
  workItems: WorkItem[];
  project: string;
  areaPath: string;
  onSelectItem?: (workItem: WorkItem) => void;
}

const ReleaseView: React.FC<ReleaseViewProps> = ({
  project,
  areaPath,
  onSelectItem,
}) => {
  // 1. useState
  const [releaseEpics, setReleaseEpics] = useState<ReleaseEpic[]>([]);
  const [loadingEpics, setLoadingEpics] = useState(false);
  const [selectedEpicId, setSelectedEpicId] = useState<number | null>(null);

  // Top control bar filters & sort
  const [platformFilter, setPlatformFilter] = useState<string>('All');
  const [lifecycleScope, setLifecycleScope] = useState<LifecycleScope>('active');
  const [releaseSearch, setReleaseSearch] = useState<string>('');
  const [sortBy, setSortBy] = useState<ReleaseSortBy>('manual');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');

  // Inspector tabs & readiness gap filter
  const [activeWorkItemTab, setActiveWorkItemTab] = useState<WorkItemTabMode>('needs-attention');
  const [activeGapFilter, setActiveGapFilter] = useState<ReadinessGapFilter | null>(null);
  const [selectedHasOutcome, setSelectedHasOutcome] = useState<boolean>(false);

  // Related / nested work items
  const [childItems, setChildItems] = useState<Map<number, WorkItem[]>>(new Map());
  const [loadingChildren, setLoadingChildren] = useState<Set<number>>(new Set());
  const [itemsWithUatReadyChildren, setItemsWithUatReadyChildren] = useState<Set<number>>(new Set());
  const [expandedNestedItems, setExpandedNestedItems] = useState<Set<string>>(new Set());
  const [nestedChildren, setNestedChildren] = useState<Map<number, WorkItem[]>>(new Map());
  const [loadingNestedChildren, setLoadingNestedChildren] = useState<Set<number>>(new Set());

  // Create / Edit release modal
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [editingEpic, setEditingEpic] = useState<ReleaseEpic | null>(null);
  const [formSubmitError, setFormSubmitError] = useState<string | null>(null);
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);

  // Link items modal
  const [showLinkItemsModal, setShowLinkItemsModal] = useState(false);
  const [linkingEpicId, setLinkingEpicId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [workItemTypeFilter, setWorkItemTypeFilter] = useState('All');
  const [searchResults, setSearchResults] = useState<WorkItem[]>([]);
  const [selectedItemsToLink, setSelectedItemsToLink] = useState<number[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Delete modal
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [deletingEpicId, setDeletingEpicId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Modals / Popovers / Panels
  const [showProgressInfo, setShowProgressInfo] = useState(false);
  const [showNotesMenu, setShowNotesMenu] = useState(false);
  const [showOutcomeModal, setShowOutcomeModal] = useState(false);
  const [outcomeReleaseVersion, setOutcomeReleaseVersion] = useState<string>('');
  const [outcomeDeployedAt, setOutcomeDeployedAt] = useState<string | undefined>(undefined);
  const [showReport, setShowReport] = useState(false);
  const [cabModalEpic, setCabModalEpic] = useState<{ id: number; version: string } | null>(null);
  const [cabPanel, setCabPanel] = useState<{
    requestId: number;
    epicId: number;
    version: string;
    relatedWorkItemIds: number[];
    previousReleaseBranch: string;
    snowMode: CreateCabRequestFormValues['snowMode'];
    cutReleaseBranch: boolean;
  } | null>(null);

  // Inline rename state
  const [inlineEditEpicId, setInlineEditEpicId] = useState<number | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);

  // Drag & drop state
  const [draggedEpicId, setDraggedEpicId] = useState<number | null>(null);
  const [dropTargetEpicId, setDropTargetEpicId] = useState<number | null>(null);
  const [assignmentNotice, setAssignmentNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [movingItemId, setMovingItemId] = useState<number | null>(null);

  // 2. useRef
  const cabRequestGenerationRef = useRef(0);
  const draggedEpicIdRef = useRef<number | null>(null);
  const draggedReleaseItemRef = useRef<{ sourceEpicId: number; item: WorkItem } | null>(null);
  const releaseViewRef = useRef<HTMLDivElement>(null);
  const topEdgeRef = useRef<HTMLDivElement>(null);
  const bottomEdgeRef = useRef<HTMLDivElement>(null);
  const scrollDirectionRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const revealDropZonesFrameRef = useRef<number | null>(null);
  const ignoreCardClickRef = useRef(false);

  // 4. useMemo / useCallback
  const availablePlatforms = useMemo(
    () => collectAvailablePlatforms(releaseEpics, project),
    [releaseEpics, project],
  );

  const visibleEpics = useMemo(() => {
    const filtered = filterReleaseEpics(releaseEpics, {
      platform: platformFilter,
      scope: lifecycleScope,
      search: releaseSearch,
      project,
    });
    return sortReleaseEpics(filtered, sortBy, sortDirection);
  }, [releaseEpics, platformFilter, lifecycleScope, releaseSearch, project, sortBy, sortDirection]);

  const selectedEpic = useMemo(
    () => visibleEpics.find((e) => e.id === selectedEpicId) ?? visibleEpics[0] ?? null,
    [visibleEpics, selectedEpicId],
  );

  const selectedRelatedItems = useMemo(
    () => (selectedEpic ? childItems.get(selectedEpic.id) ?? [] : []),
    [selectedEpic, childItems],
  );

  const readinessSummary = useMemo(
    () =>
      selectedEpic
        ? computeReleaseReadiness(selectedRelatedItems, selectedEpic, selectedHasOutcome)
        : null,
    [selectedEpic, selectedRelatedItems, selectedHasOutcome],
  );

  const inspectorItems = useMemo(
    () => filterAndSortInspectorItems(selectedRelatedItems, activeWorkItemTab, activeGapFilter),
    [selectedRelatedItems, activeWorkItemTab, activeGapFilter],
  );

  const tabCounts = useMemo(() => {
    let needsAttention = 0;
    let ready = 0;
    for (const item of selectedRelatedItems) {
      if (classifyWorkItemReadiness(item) === 'green') ready++;
      else needsAttention++;
    }
    return { needsAttention, ready, all: selectedRelatedItems.length };
  }, [selectedRelatedItems]);

  const fetchReleaseEpics = useCallback(async (options?: { background?: boolean; selectId?: number }) => {
    const background = options?.background ?? false;
    if (!background) setLoadingEpics(true);
    try {
      const response = await fetch(
        `/api/releases/epics?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
      );
      if (!response.ok) {
        console.error('Failed to fetch release epics:', response.status, response.statusText);
        if (!background) setReleaseEpics([]);
        return;
      }
      const data = await response.json();
      const epics: ReleaseEpic[] = Array.isArray(data) ? data : [];
      setReleaseEpics(epics);
      if (options?.selectId !== undefined) {
        setSelectedEpicId(options.selectId);
      }
    } catch (error) {
      console.error('Error fetching release epics:', error);
      if (!background) setReleaseEpics([]);
    } finally {
      if (!background) setLoadingEpics(false);
    }
  }, [project, areaPath]);

  const checkForUatReadyChildren = useCallback(async (workItemId: number, workItemType: string) => {
    if (workItemType !== 'Epic' && workItemType !== 'Feature') return;
    try {
      const endpoint = workItemType === 'Epic'
        ? `/api/epics/${workItemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
        : `/api/features/${workItemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
      const response = await fetch(endpoint);
      if (!response.ok) return;
      const children = await response.json();
      const hasUatReady = Array.isArray(children) && children.some((child: WorkItem) =>
        child.state === 'UAT - Ready For Test' ||
        child.state === 'UAT Ready For Test' ||
        child.state === 'UAT-Ready For Test',
      );
      if (hasUatReady) {
        setItemsWithUatReadyChildren((prev) => new Set(prev).add(workItemId));
      }
    } catch (error) {
      console.error('Error checking for UAT-ready children:', error);
    }
  }, [project, areaPath]);

  const loadRelatedItems = useCallback(async (epicId: number) => {
    setLoadingChildren((prev) => new Set(prev).add(epicId));
    try {
      const response = await fetch(
        `/api/releases/${epicId}/related-items?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
      );
      if (!response.ok) {
        console.error(`Failed to fetch children: ${response.status} ${response.statusText}`);
        return;
      }
      const children: WorkItem[] = await response.json();
      setChildItems((prev) => {
        const next = new Map(prev);
        next.set(epicId, Array.isArray(children) ? children : []);
        return next;
      });
      if (Array.isArray(children)) {
        for (const child of children) {
          if (child.workItemType === 'Epic' || child.workItemType === 'Feature') {
            void checkForUatReadyChildren(child.id, child.workItemType);
          }
        }
      }
    } catch (error) {
      console.error('Error fetching child items:', error);
    } finally {
      setLoadingChildren((prev) => {
        const next = new Set(prev);
        next.delete(epicId);
        return next;
      });
    }
  }, [project, areaPath, checkForUatReadyChildren]);

  const searchWorkItems = useCallback(async (query: string, typeFilter: string) => {
    if (!query || query.length < 2) {
      setSearchResults([]);
      return;
    }
    setSearchLoading(true);
    try {
      const response = await fetch(
        `/api/workitems/search?query=${encodeURIComponent(query)}&type=${encodeURIComponent(typeFilter)}&project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
      );
      if (!response.ok) {
        console.error('Failed to search work items:', response.status);
        setSearchResults([]);
        return;
      }
      const data = await response.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error searching work items:', error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [project, areaPath]);

  const stopAutoScroll = useCallback(() => {
    scrollDirectionRef.current = 0;
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  const positionScrollEdges = useCallback(() => {
    const scroller = findScrollParent(releaseViewRef.current);
    if (!scroller || !topEdgeRef.current || !bottomEdgeRef.current) return;
    const rect = scroller.getBoundingClientRect();
    for (const edge of [topEdgeRef.current, bottomEdgeRef.current]) {
      edge.style.left = `${rect.left}px`;
      edge.style.width = `${rect.width}px`;
    }
    topEdgeRef.current.style.top = `${rect.top}px`;
    bottomEdgeRef.current.style.top = `${rect.bottom - 48}px`;
  }, []);

  const updateAutoScroll = useCallback((clientY: number) => {
    const scroller = findScrollParent(releaseViewRef.current);
    positionScrollEdges();
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    let direction = 0;
    if (clientY <= rect.top + SCROLL_EDGE_PX) {
      direction = -Math.max(6, Math.round(((rect.top + SCROLL_EDGE_PX - clientY) / SCROLL_EDGE_PX) * 22));
    } else if (clientY >= rect.bottom - SCROLL_EDGE_PX) {
      direction = Math.max(6, Math.round(((clientY - (rect.bottom - SCROLL_EDGE_PX)) / SCROLL_EDGE_PX) * 22));
    }
    topEdgeRef.current?.classList.toggle('active', direction < 0);
    bottomEdgeRef.current?.classList.toggle('active', direction > 0);
    scrollDirectionRef.current = direction;
    if (direction !== 0) {
      scroller.scrollTop += direction;
    }
    if (direction === 0 || scrollFrameRef.current !== null) {
      if (direction === 0) stopAutoScroll();
      return;
    }
    const tick = () => {
      const next = scrollDirectionRef.current;
      const currentScroller = findScrollParent(releaseViewRef.current);
      if (next === 0 || !currentScroller) {
        scrollFrameRef.current = null;
        return;
      }
      currentScroller.scrollTop += next;
      scrollFrameRef.current = requestAnimationFrame(tick);
    };
    scrollFrameRef.current = requestAnimationFrame(tick);
  }, [positionScrollEdges, stopAutoScroll]);

  const endCardDrag = useCallback(() => {
    if (revealDropZonesFrameRef.current !== null) {
      cancelAnimationFrame(revealDropZonesFrameRef.current);
      revealDropZonesFrameRef.current = null;
    }
    draggedReleaseItemRef.current = null;
    stopAutoScroll();
    const view = releaseViewRef.current;
    view?.classList.remove('is-moving-card');
    view?.querySelectorAll('.is-source, .active, .card-drop-active').forEach((el) => {
      el.classList.remove('is-source', 'active', 'card-drop-active');
    });
    topEdgeRef.current?.classList.remove('active');
    bottomEdgeRef.current?.classList.remove('active');
    window.setTimeout(() => {
      ignoreCardClickRef.current = false;
    }, 0);
  }, [stopAutoScroll]);

  const revealDropZones = useCallback((sourceEpicId: number) => {
    const view = releaseViewRef.current;
    if (!view || draggedReleaseItemRef.current?.sourceEpicId !== sourceEpicId) return;
    view.classList.add('is-moving-card');
    view.querySelectorAll<HTMLElement>('[data-release-drop]').forEach((card) => {
      card.classList.toggle('is-source', card.dataset.releaseDrop === String(sourceEpicId));
    });
    positionScrollEdges();
  }, [positionScrollEdges]);

  const beginCardDrag = useCallback((sourceEpicId: number, item: WorkItem, event: React.DragEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData?.('text/plain', String(item.id));
    ignoreCardClickRef.current = true;
    draggedReleaseItemRef.current = { sourceEpicId, item };
    event.currentTarget.classList.add('is-drag-source');
    if (revealDropZonesFrameRef.current !== null) {
      cancelAnimationFrame(revealDropZonesFrameRef.current);
    }
    revealDropZonesFrameRef.current = requestAnimationFrame(() => {
      revealDropZonesFrameRef.current = null;
      revealDropZones(sourceEpicId);
    });
  }, [revealDropZones]);

  const updateLocalReleaseAssignments = useCallback((targetEpicId: number, items: WorkItem[]) => {
    const movedIds = new Set(items.map((item) => item.id));
    setChildItems((previous) => {
      const next = new Map(previous);
      for (const [epicId, existingItems] of next) {
        next.set(epicId, existingItems.filter((item) => !movedIds.has(item.id)));
      }
      if (next.has(targetEpicId)) {
        const targetItems = next.get(targetEpicId) ?? [];
        const targetIds = new Set(targetItems.map((item) => item.id));
        next.set(targetEpicId, [...targetItems, ...items.filter((item) => !targetIds.has(item.id))]);
      }
      return next;
    });
  }, []);

  const handleMoveReleaseItem = useCallback(async (
    sourceEpicId: number,
    targetEpicId: number,
    item: WorkItem,
  ) => {
    if (sourceEpicId === targetEpicId || movingItemId !== null) return;
    setMovingItemId(item.id);
    setAssignmentNotice(null);
    try {
      const response = await fetch(`/api/releases/${targetEpicId}/link-related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemIds: [item.id], project, areaPath }),
      });
      if (!response.ok) {
        const error = await response.json();
        setAssignmentNotice({ kind: 'error', text: error.error || `Failed to move #${item.id}.` });
        return;
      }
      updateLocalReleaseAssignments(targetEpicId, [item]);
      setReleaseEpics((previous) => previous.map((epic) => {
        if (epic.id === sourceEpicId) return adjustReleaseEpicCounts(epic, item, -1);
        if (epic.id === targetEpicId) return adjustReleaseEpicCounts(epic, item, 1);
        return epic;
      }));
      const targetName = releaseEpics.find((epic) => epic.id === targetEpicId)?.version ?? `release #${targetEpicId}`;
      setAssignmentNotice({ kind: 'success', text: `#${item.id} moved to ${targetName}.` });
      void fetchReleaseEpics({ background: true });
    } catch (error) {
      console.error('Error moving release item:', error);
      setAssignmentNotice({ kind: 'error', text: `Failed to move #${item.id}.` });
    } finally {
      setMovingItemId(null);
    }
  }, [movingItemId, project, areaPath, updateLocalReleaseAssignments, releaseEpics, fetchReleaseEpics]);

  const dropCardOnRelease = useCallback((targetEpicId: number, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedItem = draggedReleaseItemRef.current;
    if (draggedItem && draggedItem.sourceEpicId !== targetEpicId) {
      void handleMoveReleaseItem(draggedItem.sourceEpicId, targetEpicId, draggedItem.item);
    }
    endCardDrag();
  }, [handleMoveReleaseItem, endCardDrag]);

  const startInlineEdit = useCallback((epic: ReleaseEpic) => {
    setInlineEditEpicId(epic.id);
    setInlineEditValue(epic.version);
    setRenameError(null);
  }, []);

  const cancelInlineEdit = useCallback(() => {
    setInlineEditEpicId(null);
    setInlineEditValue('');
    setRenameError(null);
  }, []);

  const commitRename = useCallback(async (epicId: number) => {
    if (!inlineEditValue.trim()) {
      setRenameError('Release name cannot be blank');
      return;
    }
    setIsSavingRename(true);
    setRenameError(null);
    try {
      const response = await fetch(`/api/releases/${epicId}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName: inlineEditValue.trim(), project, areaPath }),
      });
      if (!response.ok) {
        const data = await response.json();
        setRenameError(data.error ?? 'Failed to rename release');
        return;
      }
      setInlineEditEpicId(null);
      setInlineEditValue('');
      void fetchReleaseEpics({ background: true });
    } catch {
      setRenameError('An unexpected error occurred. Please try again.');
    } finally {
      setIsSavingRename(false);
    }
  }, [inlineEditValue, project, areaPath, fetchReleaseEpics]);

  const persistOrder = useCallback(async (orderedEpics: ReleaseEpic[]) => {
    try {
      await fetch('/api/releases/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          areaPath: areaPath ?? '',
          epicIds: orderedEpics.map((e) => e.id),
        }),
      });
    } catch (err) {
      console.error('[ReleaseView] Failed to persist release order:', err);
    }
  }, [project, areaPath]);

  const handleReorderByIds = useCallback((fromEpicId: number, toEpicId: number) => {
    const fromIndex = releaseEpics.findIndex((e) => e.id === fromEpicId);
    const toIndex = releaseEpics.findIndex((e) => e.id === toEpicId);
    const reordered = reorderReleases(releaseEpics, fromIndex, toIndex);
    if (!reordered) return;
    setReleaseEpics(reordered);
    setSortBy('manual');
    void persistOrder(reordered);
  }, [releaseEpics, persistOrder]);

  const handleConfirmCabRequest = useCallback(async (
    epic: { id: number; version: string },
    values: CreateCabRequestFormValues,
  ) => {
    const requestId = cabRequestGenerationRef.current + 1;
    cabRequestGenerationRef.current = requestId;
    let relatedIds = (childItems.get(epic.id) ?? []).map((item) => item.id);
    try {
      const response = await fetch(
        `/api/releases/${epic.id}/related-items?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
      );
      if (response.ok) {
        const children = await response.json() as WorkItem[];
        relatedIds = children.map((item) => item.id);
      }
    } catch {
      // Keep cached items when refresh fails.
    }

    if (cabRequestGenerationRef.current !== requestId) return;

    setCabPanel({
      requestId,
      epicId: epic.id,
      version: epic.version,
      relatedWorkItemIds: relatedIds,
      previousReleaseBranch: values.previousReleaseBranch,
      snowMode: values.snowMode,
      cutReleaseBranch: values.cutReleaseBranch,
    });
    setCabModalEpic(null);
  }, [areaPath, childItems, project]);

  const dismissCabModal = useCallback(() => {
    cabRequestGenerationRef.current += 1;
    setCabModalEpic(null);
  }, []);

  // 5. useEffect
  useEffect(() => {
    setSelectedEpicId(null);
    setChildItems(new Map());
    void fetchReleaseEpics();
  }, [fetchReleaseEpics]);

  // Keep a valid release selected when filters/epics change
  useEffect(() => {
    if (visibleEpics.length === 0) {
      if (selectedEpicId !== null) setSelectedEpicId(null);
      return;
    }
    if (selectedEpicId === null || !visibleEpics.some((e) => e.id === selectedEpicId)) {
      setSelectedEpicId(visibleEpics[0].id);
    }
  }, [visibleEpics, selectedEpicId]);

  // Load related items automatically for the inspected release
  useEffect(() => {
    if (!selectedEpic) return;
    if (!childItems.has(selectedEpic.id) && !loadingChildren.has(selectedEpic.id)) {
      void loadRelatedItems(selectedEpic.id);
    }
  }, [selectedEpic, childItems, loadingChildren, loadRelatedItems]);

  // Close release notes dropdown when clicking outside
  useEffect(() => {
    if (!showNotesMenu) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.release-notes-dropdown-wrap')) {
        setShowNotesMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotesMenu]);

  // Debounce work item search in Link Items modal
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (showLinkItemsModal) {
        void searchWorkItems(searchQuery, workItemTypeFilter);
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [searchQuery, workItemTypeFilter, showLinkItemsModal, searchWorkItems]);

  useEffect(() => () => stopAutoScroll(), [stopAutoScroll]);

  // 6. custom hooks
  const { isInAnyGroup, permissionsLoaded } = useAppShell();
  const canManageReleases = permissionsLoaded && isInAnyGroup(['BA']);

  // Handlers
  const selectReleaseCard = (epic: ReleaseEpic) => {
    setSelectedEpicId(epic.id);
    setActiveGapFilter(null);
    setShowNotesMenu(false);
    cancelInlineEdit();
  };

  const handleOpenCreateModal = () => {
    setEditingEpic(null);
    setFormSubmitError(null);
    setShowReleaseModal(true);
  };

  const handleOpenEditModal = (epic: ReleaseEpic) => {
    setEditingEpic(epic);
    setFormSubmitError(null);
    setShowReleaseModal(true);
  };

  const handleCloseReleaseModal = () => {
    setShowReleaseModal(false);
    setEditingEpic(null);
    setFormSubmitError(null);
  };

  const handleSubmitReleaseForm = async (values: ReleaseFormValues) => {
    setIsFormSubmitting(true);
    setFormSubmitError(null);
    try {
      if (editingEpic) {
        const response = await fetch(`/api/releases/${editingEpic.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startDate: values.startDate || undefined,
            targetDate: values.targetDate || undefined,
            description: values.description || undefined,
            status: values.status,
            project,
            areaPath: editingEpic.areaPath || areaPath,
          }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          setFormSubmitError((err as { error?: string }).error || 'Failed to update release.');
          return;
        }
        handleCloseReleaseModal();
        void fetchReleaseEpics({ background: true, selectId: editingEpic.id });
      } else {
        const chosenAreaPath = values.areaPath?.trim() || areaPath;
        const response = await fetch(`/api/releases/${encodeURIComponent(values.version.trim())}/tag`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project,
            areaPath: chosenAreaPath,
            startDate: values.startDate || undefined,
            targetDate: values.targetDate || undefined,
            description: values.description || undefined,
          }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          setFormSubmitError((err as { error?: string }).error || 'Failed to create release.');
          return;
        }
        const data = await response.json() as { epicId?: number };
        handleCloseReleaseModal();
        void fetchReleaseEpics({ background: true, selectId: data.epicId });
      }
    } catch {
      setFormSubmitError('An unexpected error occurred. Please try again.');
    } finally {
      setIsFormSubmitting(false);
    }
  };

  const handleOpenOutcomeModal = (releaseVersion: string, deployedAt?: string) => {
    setOutcomeReleaseVersion(releaseVersion);
    setOutcomeDeployedAt(deployedAt);
    setShowOutcomeModal(true);
  };

  const handleCloseOutcomeModal = () => {
    setShowOutcomeModal(false);
    setOutcomeReleaseVersion('');
    setOutcomeDeployedAt(undefined);
  };

  const handleOpenLinkItemsModal = (epicId: number) => {
    setLinkingEpicId(epicId);
    setShowLinkItemsModal(true);
    setSearchQuery('');
    setWorkItemTypeFilter('All');
    setSearchResults([]);
    setSelectedItemsToLink([]);
  };

  const handleCloseLinkItemsModal = () => {
    setShowLinkItemsModal(false);
    setLinkingEpicId(null);
    setSearchQuery('');
    setWorkItemTypeFilter('All');
    setSearchResults([]);
    setSelectedItemsToLink([]);
  };

  const handleLinkItems = async () => {
    if (!linkingEpicId || selectedItemsToLink.length === 0) return;
    try {
      const response = await fetch(`/api/releases/${linkingEpicId}/link-related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workItemIds: selectedItemsToLink,
          project,
          areaPath,
        }),
      });
      if (response.ok) {
        const result = await response.json();
        const linkedItems = searchResults.filter((item) => selectedItemsToLink.includes(item.id));
        updateLocalReleaseAssignments(linkingEpicId, linkedItems);
        setReleaseEpics((previous) => previous.map((epic) =>
          epic.id === linkingEpicId
            ? linkedItems.reduce((acc, item) => adjustReleaseEpicCounts(acc, item, 1), epic)
            : epic,
        ));
        setAssignmentNotice({
          kind: 'success',
          text: result.movedCount > 0
            ? `${linkedItems.length} item${linkedItems.length === 1 ? '' : 's'} assigned; ${result.movedCount} moved from another release.`
            : `${linkedItems.length} item${linkedItems.length === 1 ? '' : 's'} assigned to the release.`,
        });
        handleCloseLinkItemsModal();
        void fetchReleaseEpics({ background: true });
      } else {
        const error = await response.json();
        setAssignmentNotice({ kind: 'error', text: error.error || 'Failed to assign items to the release.' });
      }
    } catch (error) {
      console.error('Error linking items:', error);
      setAssignmentNotice({ kind: 'error', text: 'Failed to assign items to the release.' });
    }
  };

  const handleUnlinkItem = async (epicId: number, workItem: WorkItem) => {
    if (!confirm('Are you sure you want to unlink this item from the release?')) {
      return;
    }
    try {
      const response = await fetch(`/api/releases/${epicId}/unlink-related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workItemIds: [workItem.id],
          project,
          areaPath,
        }),
      });
      if (response.ok) {
        setChildItems((prev) => {
          const next = new Map(prev);
          const items = next.get(epicId) || [];
          next.set(epicId, items.filter((item) => item.id !== workItem.id));
          return next;
        });
        setReleaseEpics((prev) =>
          prev.map((epic) => (epic.id === epicId ? adjustReleaseEpicCounts(epic, workItem, -1) : epic)),
        );
        void fetchReleaseEpics({ background: true });
      } else {
        const error = await response.json();
        alert(`Failed to unlink item: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error unlinking item:', error);
      alert('Failed to unlink item. Please try again.');
    }
  };

  const toggleNestedItemExpansion = async (epicId: number, itemId: number, workItemType: string) => {
    const cardKey = `${epicId}:${itemId}`;
    const newExpanded = new Set(expandedNestedItems);
    if (expandedNestedItems.has(cardKey)) {
      newExpanded.delete(cardKey);
      setExpandedNestedItems(newExpanded);
      return;
    }

    newExpanded.add(cardKey);
    setExpandedNestedItems(newExpanded);

    if (!nestedChildren.has(itemId)) {
      setLoadingNestedChildren((prev) => new Set(prev).add(itemId));
      try {
        const endpoint = workItemType === 'Epic'
          ? `/api/epics/${itemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
          : `/api/features/${itemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
        const response = await fetch(endpoint);
        if (response.ok) {
          const children = await response.json();
          setNestedChildren((prev) => new Map(prev).set(itemId, Array.isArray(children) ? children : []));
        }
      } catch (error) {
        console.error('Error fetching nested children:', error);
      } finally {
        setLoadingNestedChildren((prev) => {
          const next = new Set(prev);
          next.delete(itemId);
          return next;
        });
      }
    }
  };

  const handleDeleteReleaseEpic = async () => {
    if (!deletingEpicId) return;
    setIsDeleting(true);
    try {
      const response = await fetch(
        `/api/releases/${deletingEpicId}?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`,
        { method: 'DELETE' },
      );
      if (response.ok) {
        setShowDeleteConfirmModal(false);
        setDeletingEpicId(null);
        void fetchReleaseEpics({ background: true });
      } else {
        const error = await response.json();
        console.error('Failed to delete epic:', error);
        alert(`Failed to delete epic: ${error.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error('Error deleting epic:', error);
      alert('Failed to delete epic. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  const downloadReleaseNotes = async (version: string, format: 'json' | 'markdown') => {
    setShowNotesMenu(false);
    try {
      const response = await fetch(
        `/api/releases/${encodeURIComponent(version)}/notes?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}&format=${format}`,
      );
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `release-${version}-notes.${format === 'markdown' ? 'md' : 'json'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading release notes:', error);
    }
  };

  const toggleGapFilter = (gap: ReadinessGapFilter) => {
    setActiveGapFilter((current) => (current === gap ? null : gap));
  };

  const selectedPlatform = selectedEpic ? getEpicPlatform(selectedEpic, project) : '';
  const selectedCountdown = selectedEpic
    ? formatTargetDateCountdown(selectedEpic.targetDate, selectedEpic.status)
    : null;
  const selectedDescriptionText = selectedEpic?.description
    ? selectedEpic.description.replace(/<[^>]*>/g, '').trim()
    : '';
  const isSelectedLoading = selectedEpic ? loadingChildren.has(selectedEpic.id) : false;

  return (
    <div
      className="release-view"
      ref={releaseViewRef}
      {...{ 'data-testid': 'release-view' }}
      onDragOver={(event) => {
        if (!draggedReleaseItemRef.current) return;
        event.preventDefault();
        updateAutoScroll(event.clientY);
      }}
    >
      <div ref={topEdgeRef} className="release-scroll-edge top">Scroll up</div>
      <div ref={bottomEdgeRef} className="release-scroll-edge bottom">Scroll down</div>

      <div className="release-header">
        <div className="release-header-top">
          <div className="header-title-wrapper">
            <h2>Release Management</h2>
            <div className="info-icon-wrapper">
              <button
                type="button"
                className="info-icon"
                {...{ 'data-testid': 'release-progress-info' }}
                onClick={() => setShowProgressInfo(!showProgressInfo)}
                aria-label="Progress calculation info"
                title="Progress calculation info"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                  <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
                </svg>
              </button>
              {showProgressInfo && (
                <div className="progress-info-tooltip">
                  <div className="tooltip-header">
                    <h4>Progress Calculation</h4>
                    <button
                      type="button"
                      className="btn-close-tooltip"
                      {...{ 'data-testid': 'release-progress-info-close' }}
                      onClick={() => setShowProgressInfo(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="tooltip-content">
                    <p>The readiness strip shows a color-coded breakdown of work item states:</p>
                    <div className="calculation-breakdown">
                      <div className="calc-item">
                        <span className="calc-badge calc-green">✓ Green</span>
                        <span className="calc-label">Ready For Release, UAT - Test Done, Done, Closed</span>
                      </div>
                      <div className="calc-item">
                        <span className="calc-badge calc-amber">● Amber</span>
                        <span className="calc-label">UAT - Ready For Test</span>
                      </div>
                      <div className="calc-item">
                        <span className="calc-badge calc-red">○ Red</span>
                        <span className="calc-label">All other states (Dev / New / Blocked)</span>
                      </div>
                    </div>
                    <p className="tooltip-note">
                      Completion reflects only <strong>green</strong> items. Amber indicates items awaiting UAT; red indicates items still in Dev or blocked.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="release-actions">
            <button
              type="button"
              className="btn-view-report"
              {...{ 'data-testid': 'release-view-report' }}
              onClick={() => setShowReport(!showReport)}
            >
              {showReport ? '← Back to Releases' : 'View Report'}
            </button>
            <button
              type="button"
              className="btn-create-release"
              {...{ 'data-testid': 'release-create' }}
              onClick={handleOpenCreateModal}
            >
              + New Release
            </button>
          </div>
        </div>
      </div>

      {assignmentNotice && (
        <div className={`release-assignment-notice ${assignmentNotice.kind}`} role="status">
          <span>{assignmentNotice.text}</span>
          <button
            type="button"
            {...{ 'data-testid': 'release-assignment-dismiss' }}
            onClick={() => setAssignmentNotice(null)}
            aria-label="Dismiss message"
          >
            ✕
          </button>
        </div>
      )}

      {showReport ? (
        <DeploymentOutcomeReport onClose={() => setShowReport(false)} project={project} areaPath={areaPath} />
      ) : (
        <>
          {/* Top Control Bar: Platform + Lifecycle Scope + Search & Sort */}
          <div className="release-controls-bar" {...{ 'data-testid': 'release-controls-bar' }}>
            <div className="release-controls-left">
              <div className="segmented-control" role="group" aria-label="Platform filter">
                {availablePlatforms.map((platform) => {
                  const active = platformFilter.toLowerCase() === platform.toLowerCase();
                  return (
                    <button
                      key={platform}
                      type="button"
                      className={`segmented-btn${active ? ' active' : ''}`}
                      {...{ 'data-testid': `release-platform-filter-${toSlug(platform)}` }}
                      onClick={() => setPlatformFilter(platform)}
                    >
                      {platform}
                    </button>
                  );
                })}
              </div>

              <div className="segmented-control" role="group" aria-label="Lifecycle scope filter">
                {(
                  [
                    { key: 'active', label: 'Active & Upcoming' },
                    { key: 'shipped', label: 'Shipped' },
                    { key: 'all', label: 'All' },
                  ] as const
                ).map((scope) => (
                  <button
                    key={scope.key}
                    type="button"
                    className={`segmented-btn${lifecycleScope === scope.key ? ' active' : ''}`}
                    {...{ 'data-testid': `release-scope-filter-${scope.key}` }}
                    onClick={() => setLifecycleScope(scope.key)}
                  >
                    {scope.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="release-controls-right">
              <div className="release-search-box">
                <input
                  type="search"
                  className="release-search-input"
                  placeholder="Search releases..."
                  value={releaseSearch}
                  onChange={(e) => setReleaseSearch(e.target.value)}
                  aria-label="Search releases"
                  {...{ 'data-testid': 'release-search-input' }}
                />
                {releaseSearch && (
                  <button
                    type="button"
                    className="release-search-clear"
                    onClick={() => setReleaseSearch('')}
                    aria-label="Clear search"
                    {...{ 'data-testid': 'release-search-clear' }}
                  >
                    ✕
                  </button>
                )}
              </div>

              <div className="release-sort-group">
                <label className="release-sort-label" htmlFor="release-sort-select">Sort:</label>
                <select
                  id="release-sort-select"
                  className="release-sort-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as ReleaseSortBy)}
                  {...{ 'data-testid': 'release-sort-select' }}
                >
                  <option value="manual">Manual Order</option>
                  <option value="targetDate">Target Date</option>
                  <option value="progress">Progress</option>
                  <option value="version">Version</option>
                </select>
                {sortBy !== 'manual' && (
                  <button
                    type="button"
                    className="release-sort-dir-btn"
                    onClick={() => setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                    title={sortDirection === 'asc' ? 'Ascending — click to reverse' : 'Descending — click to reverse'}
                    {...{ 'data-testid': 'release-sort-direction' }}
                  >
                    {sortDirection === 'asc' ? '↑' : '↓'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {loadingEpics ? (
            <div className="loading-message">Loading releases...</div>
          ) : releaseEpics.length === 0 ? (
            <div className="empty-message" {...{ 'data-testid': 'release-empty-state' }}>
              No releases yet. Click &quot;+ New Release&quot; to create one.
            </div>
          ) : (
            <div className="release-workspace" {...{ 'data-testid': 'release-workspace' }}>
              {/* Left Pane: Release Queue */}
              <div className="release-queue-pane" {...{ 'data-testid': 'release-queue-pane' }}>
                {visibleEpics.length === 0 ? (
                  <div className="release-queue-empty" {...{ 'data-testid': 'release-queue-empty' }}>
                    <p>No releases match the current filters.</p>
                    <button
                      type="button"
                      className="btn-secondary"
                      {...{ 'data-testid': 'release-filters-reset' }}
                      onClick={() => {
                        setPlatformFilter('All');
                        setLifecycleScope('all');
                        setReleaseSearch('');
                      }}
                    >
                      Reset filters
                    </button>
                  </div>
                ) : (
                  <div className="release-queue-list">
                    {visibleEpics.map((epic) => {
                      const platform = getEpicPlatform(epic, project);
                      const countdown = formatTargetDateCountdown(epic.targetDate, epic.status);
                      const remainingLabel = formatRemainingSummary(epic);
                      const buckets = getEpicBucketCounts(epic);
                      const isSelected = selectedEpic?.id === epic.id;
                      const isDraggingCard = draggedEpicId === epic.id;
                      const isReorderTarget = dropTargetEpicId === epic.id && draggedEpicId !== null && draggedEpicId !== epic.id;

                      return (
                        <div
                          key={epic.id}
                          role="button"
                          tabIndex={0}
                          data-release-drop={epic.id}
                          {...{ 'data-testid': `release-card-${epic.id}` }}
                          className={[
                            'release-queue-card',
                            isSelected ? 'selected' : '',
                            isDraggingCard ? 'row-dragging' : '',
                            isReorderTarget ? 'row-drop-target' : '',
                          ].filter(Boolean).join(' ')}
                          onClick={() => selectReleaseCard(epic)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              selectReleaseCard(epic);
                            }
                          }}
                          onDragEnter={canManageReleases ? (e) => {
                            if (draggedReleaseItemRef.current && draggedReleaseItemRef.current.sourceEpicId !== epic.id) {
                              e.preventDefault();
                              releaseViewRef.current?.querySelectorAll('.release-queue-card.card-drop-active').forEach((c) => {
                                c.classList.remove('card-drop-active');
                              });
                              e.currentTarget.classList.add('card-drop-active');
                            } else if (sortBy === 'manual' && draggedEpicIdRef.current !== null && draggedEpicIdRef.current !== epic.id) {
                              e.preventDefault();
                            }
                          } : undefined}
                          onDragOver={canManageReleases ? (e) => {
                            if (draggedReleaseItemRef.current) {
                              if (draggedReleaseItemRef.current.sourceEpicId === epic.id) return;
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = 'move';
                              updateAutoScroll(e.clientY);
                              return;
                            }
                            if (sortBy === 'manual' && draggedEpicIdRef.current !== null) {
                              e.preventDefault();
                              setDropTargetEpicId(epic.id);
                            }
                          } : undefined}
                          onDrop={canManageReleases ? (e) => {
                            if (draggedReleaseItemRef.current) {
                              dropCardOnRelease(epic.id, e);
                              return;
                            }
                            e.preventDefault();
                            const fromId = draggedEpicIdRef.current;
                            if (sortBy === 'manual' && fromId !== null && fromId !== epic.id) {
                              handleReorderByIds(fromId, epic.id);
                            }
                            draggedEpicIdRef.current = null;
                            setDraggedEpicId(null);
                            setDropTargetEpicId(null);
                          } : undefined}
                        >
                          <div className="release-card-top">
                            <div className="release-card-identity">
                              {canManageReleases && (
                                <div
                                  className={`drag-handle${sortBy !== 'manual' ? ' drag-handle-disabled' : ''}`}
                                  {...{ 'data-testid': `release-drag-handle-${epic.id}` }}
                                  title={sortBy === 'manual' ? 'Drag to reorder' : 'Switch sort to Manual Order to reorder releases'}
                                  draggable={sortBy === 'manual'}
                                  onClick={(e) => e.stopPropagation()}
                                  onDragStart={(event) => {
                                    if (sortBy !== 'manual') return;
                                    event.stopPropagation();
                                    event.dataTransfer.effectAllowed = 'move';
                                    event.dataTransfer.setData?.('text/plain', `release-order:${epic.id}`);
                                    draggedEpicIdRef.current = epic.id;
                                    requestAnimationFrame(() => {
                                      if (draggedEpicIdRef.current === epic.id) {
                                        setDraggedEpicId(epic.id);
                                      }
                                    });
                                  }}
                                  onDragEnd={() => {
                                    draggedEpicIdRef.current = null;
                                    setDraggedEpicId(null);
                                    setDropTargetEpicId(null);
                                  }}
                                >
                                  ⠿
                                </div>
                              )}
                              <span
                                className={`platform-badge ${platformToneClass(platform)}`}
                                {...{ 'data-testid': `release-platform-badge-${epic.id}` }}
                              >
                                {platform}
                              </span>
                              <span
                                className="release-card-version"
                                {...{ 'data-testid': `release-card-version-${epic.id}` }}
                              >
                                {epic.version}
                              </span>
                            </div>
                            <span className={`status-badge status-${toSlug(epic.status)}`}>
                              {epic.status}
                            </span>
                          </div>

                          <div className="release-card-meta">
                            <span
                              className={`release-countdown countdown-${countdown.variant}`}
                              {...{ 'data-testid': `release-card-countdown-${epic.id}` }}
                            >
                              {countdown.label}
                            </span>
                            <OutcomeBadge
                              {...{ 'data-testid': `release-outcome-badge-${epic.id}` }}
                              releaseVersion={epic.version}
                              deployedAt={epic.targetDate || undefined}
                              onManage={handleOpenOutcomeModal}
                            />
                          </div>

                          <div className="release-card-readiness">
                            <div className="progress-bar-container">
                              {buckets.total > 0 && (
                                <>
                                  <div
                                    className="progress-bar-segment segment-green"
                                    style={{ width: `${(buckets.green / buckets.total) * 100}%` }}
                                    title={`Ready: ${buckets.green}`}
                                  />
                                  <div
                                    className="progress-bar-segment segment-amber"
                                    style={{ width: `${(buckets.amber / buckets.total) * 100}%` }}
                                    title={`UAT Ready: ${buckets.amber}`}
                                  />
                                  <div
                                    className="progress-bar-segment segment-red"
                                    style={{ width: `${(buckets.red / buckets.total) * 100}%` }}
                                    title={`Dev / Not Ready: ${buckets.red}`}
                                  />
                                </>
                              )}
                            </div>
                            <span className="progress-details" {...{ 'data-testid': `release-card-ratio-${epic.id}` }}>
                              {buckets.green}/{buckets.total} ({epic.progress}%)
                            </span>
                          </div>

                          <div className="release-card-footer">
                            <span
                              className={`remaining-chip${buckets.red === 0 && buckets.amber === 0 && buckets.total > 0 ? ' all-ready' : ''}`}
                              {...{ 'data-testid': `release-card-remaining-${epic.id}` }}
                            >
                              {remainingLabel}
                            </span>
                          </div>

                          {canManageReleases && (
                            <div className="release-card-drop-hint">
                              Drop here to add to {epic.version}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right Pane: Release Inspector */}
              <div className="release-inspector-pane" {...{ 'data-testid': 'release-inspector' }}>
                {!selectedEpic ? (
                  <div className="inspector-empty-state">
                    <p>Select a release from the queue to inspect its readiness and linked work items.</p>
                  </div>
                ) : (
                  <>
                    <ReleaseInspectorOutcomeSync
                      releaseVersion={selectedEpic.version}
                      onPresenceChange={setSelectedHasOutcome}
                    />

                    {/* Inspector Header */}
                    <div className="inspector-header">
                      <div className="inspector-header-main">
                        <div className="inspector-title-row">
                          <span
                            className={`platform-badge ${platformToneClass(selectedPlatform)}`}
                            {...{ 'data-testid': `release-inspector-platform-${selectedEpic.id}` }}
                          >
                            {selectedPlatform}
                          </span>

                          {inlineEditEpicId === selectedEpic.id ? (
                            <span className="inline-rename-wrapper">
                              <input
                                className="inline-rename-input"
                                {...{ 'data-testid': `release-rename-input-${selectedEpic.id}` }}
                                value={inlineEditValue}
                                autoFocus
                                onChange={(e) => setInlineEditValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { void commitRename(selectedEpic.id); }
                                  if (e.key === 'Escape') { cancelInlineEdit(); }
                                }}
                                onBlur={() => { void commitRename(selectedEpic.id); }}
                                disabled={isSavingRename}
                              />
                              {renameError && (
                                <span className="rename-error" {...{ 'data-testid': `release-rename-error-${selectedEpic.id}` }}>
                                  {renameError}
                                </span>
                              )}
                            </span>
                          ) : canManageReleases && isRenamableStatus(selectedEpic.status) ? (
                            <button
                              type="button"
                              className="inspector-version-btn version-editable"
                              {...{ 'data-testid': `release-rename-${selectedEpic.id}` }}
                              title="Click to rename"
                              onClick={() => startInlineEdit(selectedEpic)}
                            >
                              <span>{selectedEpic.version}</span>
                              <span className="edit-pencil" aria-hidden>✎</span>
                            </button>
                          ) : (
                            <h3
                              className="inspector-version-title"
                              {...{ 'data-testid': `release-rename-${selectedEpic.id}` }}
                            >
                              {selectedEpic.version}
                            </h3>
                          )}

                          <span className={`status-badge status-${toSlug(selectedEpic.status)}`}>
                            {selectedEpic.status}
                          </span>
                        </div>

                        <div className="inspector-dates-row">
                          <span>
                            <strong>Start:</strong> {selectedEpic.startDate || 'Not set'}
                          </span>
                          <span>
                            <strong>Target:</strong>{' '}
                            {selectedEpic.targetDate ? (
                              <span className={`release-countdown countdown-${selectedCountdown?.variant ?? 'upcoming'}`}>
                                {selectedEpic.targetDate} ({selectedCountdown?.label})
                              </span>
                            ) : (
                              <span className="release-countdown countdown-none">No target date</span>
                            )}
                          </span>
                          {selectedEpic.areaPath && (
                            <span className="inspector-area-path">
                              <strong>Area:</strong> {selectedEpic.areaPath}
                            </span>
                          )}
                        </div>

                        <p className="inspector-description">
                          {selectedDescriptionText || 'No release description provided.'}
                        </p>
                      </div>

                      <div className="inspector-actions">
                        <button
                          type="button"
                          className="inspector-action-btn primary"
                          {...{ 'data-testid': `release-action-link-${selectedEpic.id}` }}
                          onClick={() => handleOpenLinkItemsModal(selectedEpic.id)}
                        >
                          + Link Items
                        </button>
                        <button
                          type="button"
                          className="inspector-action-btn"
                          {...{ 'data-testid': `release-action-edit-${selectedEpic.id}` }}
                          onClick={() => handleOpenEditModal(selectedEpic)}
                        >
                          Edit
                        </button>
                        <ReleaseCabRequestAction
                          project={project}
                          onClick={() => setCabModalEpic({ id: selectedEpic.id, version: selectedEpic.version })}
                          {...{ 'data-testid': `release-create-cab-${selectedEpic.id}` }}
                        />
                        <button
                          type="button"
                          className="inspector-action-btn"
                          {...{ 'data-testid': `release-action-outcome-${selectedEpic.id}` }}
                          onClick={() => handleOpenOutcomeModal(selectedEpic.version, selectedEpic.targetDate || undefined)}
                        >
                          Deployment Outcome
                        </button>
                        <div className="release-notes-dropdown-wrap">
                          <button
                            type="button"
                            className="inspector-action-btn"
                            {...{ 'data-testid': `release-action-notes-${selectedEpic.id}` }}
                            onClick={() => setShowNotesMenu((prev) => !prev)}
                          >
                            Release Notes ▾
                          </button>
                          {showNotesMenu && (
                            <div className="action-dropdown">
                              <button
                                type="button"
                                className="action-menu-item"
                                {...{ 'data-testid': 'release-notes-markdown' }}
                                onClick={() => void downloadReleaseNotes(selectedEpic.version, 'markdown')}
                              >
                                Download Markdown
                              </button>
                              <button
                                type="button"
                                className="action-menu-item"
                                {...{ 'data-testid': 'release-notes-json' }}
                                onClick={() => void downloadReleaseNotes(selectedEpic.version, 'json')}
                              >
                                Download JSON
                              </button>
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="inspector-action-btn danger"
                          {...{ 'data-testid': `release-action-delete-${selectedEpic.id}` }}
                          onClick={() => {
                            setDeletingEpicId(selectedEpic.id);
                            setShowDeleteConfirmModal(true);
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* "What Else Is Needed" Readiness Summary */}
                    <div className="readiness-summary" {...{ 'data-testid': 'readiness-summary' }}>
                      <div className="readiness-summary-header">
                        <h4>What Else Is Needed</h4>
                        <span className="readiness-summary-total">
                          {selectedRelatedItems.length} linked item{selectedRelatedItems.length === 1 ? '' : 's'}
                        </span>
                      </div>

                      {isSelectedLoading && !childItems.has(selectedEpic.id) ? (
                        <div className="readiness-loading">Calculating readiness breakdown...</div>
                      ) : readinessSummary && (
                        <>
                          <div className="readiness-counters">
                            <div className="readiness-counter ready">
                              <span className="readiness-counter-value" {...{ 'data-testid': 'readiness-count-ready' }}>
                                {readinessSummary.readyCount}
                              </span>
                              <span className="readiness-counter-label">Ready / Done</span>
                            </div>
                            <div className="readiness-counter uat">
                              <span className="readiness-counter-value" {...{ 'data-testid': 'readiness-count-uat' }}>
                                {readinessSummary.uatCount}
                              </span>
                              <span className="readiness-counter-label">Awaiting UAT</span>
                            </div>
                            <div className="readiness-counter not-ready">
                              <span className="readiness-counter-value" {...{ 'data-testid': 'readiness-count-not-ready' }}>
                                {readinessSummary.notReadyCount}
                              </span>
                              <span className="readiness-counter-label">Not Ready</span>
                            </div>
                          </div>

                          <div className="readiness-gaps" {...{ 'data-testid': 'readiness-gaps' }}>
                            {readinessSummary.notReadyCount > 0 && (
                              <button
                                type="button"
                                className={`gap-pill gap-dev${activeGapFilter === 'dev' ? ' active' : ''}`}
                                {...{ 'data-testid': 'gap-pill-dev' }}
                                onClick={() => toggleGapFilter('dev')}
                              >
                                {readinessSummary.notReadyCount} {readinessSummary.notReadyCount === 1 ? 'item' : 'items'} still in Dev
                              </button>
                            )}
                            {readinessSummary.uatCount > 0 && (
                              <button
                                type="button"
                                className={`gap-pill gap-uat${activeGapFilter === 'uat' ? ' active' : ''}`}
                                {...{ 'data-testid': 'gap-pill-uat' }}
                                onClick={() => toggleGapFilter('uat')}
                              >
                                {readinessSummary.uatCount} awaiting UAT
                              </button>
                            )}
                            {readinessSummary.unassignedCount > 0 && (
                              <button
                                type="button"
                                className={`gap-pill gap-unassigned${activeGapFilter === 'unassigned' ? ' active' : ''}`}
                                {...{ 'data-testid': 'gap-pill-unassigned' }}
                                onClick={() => toggleGapFilter('unassigned')}
                              >
                                {readinessSummary.unassignedCount} unassigned
                              </button>
                            )}
                            {readinessSummary.missingTargetDate && (
                              <button
                                type="button"
                                className="gap-pill gap-meta"
                                {...{ 'data-testid': 'gap-pill-no-target-date' }}
                                onClick={() => handleOpenEditModal(selectedEpic)}
                                title="Click to set a target date"
                              >
                                No target date
                              </button>
                            )}
                            {readinessSummary.missingOutcome && (
                              <button
                                type="button"
                                className="gap-pill gap-meta"
                                {...{ 'data-testid': 'gap-pill-no-outcome' }}
                                onClick={() => handleOpenOutcomeModal(selectedEpic.version, selectedEpic.targetDate || undefined)}
                                title="Click to record deployment outcome"
                              >
                                No deployment outcome recorded
                              </button>
                            )}
                            {readinessSummary.isAllClear && (
                              <span className="gap-pill gap-clear" {...{ 'data-testid': 'readiness-all-clear' }}>
                                ✓ All items ready &amp; outcome recorded
                              </span>
                            )}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Scoped Work-Item Tabs */}
                    <div className="inspector-tabs-bar">
                      <div className="inspector-tabs" role="tablist" aria-label="Release work items filter">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={!activeGapFilter && activeWorkItemTab === 'needs-attention'}
                          className={`inspector-tab${!activeGapFilter && activeWorkItemTab === 'needs-attention' ? ' active' : ''}`}
                          {...{ 'data-testid': 'release-tab-needs-attention' }}
                          onClick={() => {
                            setActiveGapFilter(null);
                            setActiveWorkItemTab('needs-attention');
                          }}
                        >
                          Needs Attention ({tabCounts.needsAttention})
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={!activeGapFilter && activeWorkItemTab === 'ready'}
                          className={`inspector-tab${!activeGapFilter && activeWorkItemTab === 'ready' ? ' active' : ''}`}
                          {...{ 'data-testid': 'release-tab-ready' }}
                          onClick={() => {
                            setActiveGapFilter(null);
                            setActiveWorkItemTab('ready');
                          }}
                        >
                          Ready / Done ({tabCounts.ready})
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={!activeGapFilter && activeWorkItemTab === 'all'}
                          className={`inspector-tab${!activeGapFilter && activeWorkItemTab === 'all' ? ' active' : ''}`}
                          {...{ 'data-testid': 'release-tab-all' }}
                          onClick={() => {
                            setActiveGapFilter(null);
                            setActiveWorkItemTab('all');
                          }}
                        >
                          All Items ({tabCounts.all})
                        </button>
                      </div>

                      {activeGapFilter && (
                        <div className="gap-filter-active-bar">
                          <span>
                            Filtered by:{' '}
                            <strong>
                              {activeGapFilter === 'dev'
                                ? 'Still in Dev'
                                : activeGapFilter === 'uat'
                                  ? 'Awaiting UAT'
                                  : 'Unassigned'}
                            </strong>
                          </span>
                          <button
                            type="button"
                            className="gap-filter-reset-btn"
                            {...{ 'data-testid': 'gap-filter-reset' }}
                            onClick={() => setActiveGapFilter(null)}
                          >
                            Clear filter
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Work Items List */}
                    <div className="inspector-items-body">
                      {isSelectedLoading && !childItems.has(selectedEpic.id) ? (
                        <div className="child-loading">
                          <div className="loading-spinner" />
                          <span>Loading work items...</span>
                        </div>
                      ) : selectedRelatedItems.length === 0 ? (
                        <div className="child-empty">
                          <div className="empty-icon">📋</div>
                          <div className="empty-text">No items linked to this release yet</div>
                          <div className="empty-hint">Click &quot;+ Link Items&quot; to add work items to this release</div>
                        </div>
                      ) : inspectorItems.length === 0 ? (
                        <div className="child-empty" {...{ 'data-testid': 'inspector-filtered-empty' }}>
                          <div className="empty-text">
                            {activeWorkItemTab === 'needs-attention' && !activeGapFilter
                              ? 'Nothing needs attention — all linked items are ready!'
                              : 'No work items match this view.'}
                          </div>
                        </div>
                      ) : (
                        <div className="child-items-grid">
                          {inspectorItems.map((item) => {
                            const stateClass = toSlug(item.state);
                            const typeClass = toSlug(item.workItemType);
                            const readinessBucket = classifyWorkItemReadiness(item);
                            const hasUatReadyChildren = itemsWithUatReadyChildren.has(item.id);
                            const isExpandable = item.workItemType === 'Epic' || item.workItemType === 'Feature';
                            const isExpanded = expandedNestedItems.has(`${selectedEpic.id}:${item.id}`);

                            return (
                              <div
                                key={item.id}
                                className={`child-item-card type-${typeClass} readiness-${readinessBucket}${hasUatReadyChildren ? ' has-uat-ready' : ''}${isExpanded ? ' expanded' : ''}${movingItemId === item.id ? ' moving' : ''}`}
                                {...{ 'data-testid': `release-item-${selectedEpic.id}-${item.id}` }}
                                draggable={canManageReleases && movingItemId === null}
                                title={canManageReleases ? 'Drag to another release, or click to view details' : undefined}
                                onDragStart={canManageReleases ? (event) => beginCardDrag(selectedEpic.id, item, event) : undefined}
                                onDragEnd={canManageReleases ? (event) => {
                                  event.currentTarget.classList.remove('is-drag-source');
                                  endCardDrag();
                                } : undefined}
                                onClick={canManageReleases ? (event) => {
                                  if (ignoreCardClickRef.current) return;
                                  if ((event.target as HTMLElement).closest('button')) return;
                                  onSelectItem?.(item);
                                } : undefined}
                              >
                                {isExpandable && (
                                  <button
                                    type="button"
                                    className="btn-expand-nested"
                                    {...{ 'data-testid': `release-item-expand-${selectedEpic.id}-${item.id}` }}
                                    draggable={false}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void toggleNestedItemExpansion(selectedEpic.id, item.id, item.workItemType);
                                    }}
                                    title={isExpanded ? 'Collapse children' : 'Expand to view children'}
                                  >
                                    <svg
                                      width="20"
                                      height="20"
                                      viewBox="0 0 20 20"
                                      fill="none"
                                      className={`expand-icon${isExpanded ? ' expanded' : ''}`}
                                    >
                                      <path
                                        d="M6 8L10 12L14 8"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  </button>
                                )}

                                <div
                                  className="child-item-content"
                                  {...{ 'data-testid': `release-item-open-${selectedEpic.id}-${item.id}` }}
                                  onClick={canManageReleases ? undefined : () => onSelectItem?.(item)}
                                  title={canManageReleases ? undefined : 'Click to view details'}
                                >
                                  <div className="child-item-header">
                                    <span className="child-item-id">#{item.id}</span>
                                    <span className={`child-item-type type-${typeClass}`}>
                                      {item.workItemType}
                                    </span>
                                    <span className={`child-item-state state-${stateClass}`}>
                                      {item.state}
                                    </span>
                                  </div>

                                  <div className="child-item-title" title={item.title}>
                                    {item.title}
                                  </div>

                                  <div className="child-item-footer">
                                    <div className="footer-left">
                                      {item.assignedTo ? (
                                        <div className="child-item-assignee">
                                          <span className="assignee-avatar">
                                            {item.assignedTo.split(' ').map((n) => n[0]).join('').toUpperCase().substring(0, 2)}
                                          </span>
                                          <span className="assignee-name">{item.assignedTo}</span>
                                        </div>
                                      ) : (
                                        <div className="child-item-unassigned">
                                          <span className="unassigned-icon">👤</span>
                                          <span className="unassigned-text">Unassigned</span>
                                        </div>
                                      )}
                                      {item.targetDate && (
                                        <div className="child-item-date">
                                          <span className="date-icon">📅</span>
                                          <span className="date-text">{new Date(item.targetDate).toLocaleDateString()}</span>
                                        </div>
                                      )}
                                    </div>

                                    <button
                                      type="button"
                                      className="btn-unlink-item"
                                      {...{ 'data-testid': `release-item-unlink-${selectedEpic.id}-${item.id}` }}
                                      draggable={false}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleUnlinkItem(selectedEpic.id, item);
                                      }}
                                      title="Unlink from release"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                </div>

                                {isExpanded && (
                                  <div className="nested-children-container">
                                    {loadingNestedChildren.has(item.id) ? (
                                      <div className="nested-loading">
                                        <div className="loading-spinner" />
                                        <span>Loading child items...</span>
                                      </div>
                                    ) : (nestedChildren.get(item.id)?.length ?? 0) === 0 ? (
                                      <div className="nested-empty">
                                        <span>No child items found</span>
                                      </div>
                                    ) : (
                                      <div className="nested-items-list">
                                        {nestedChildren.get(item.id)?.map((nestedItem) => {
                                          const nestedStateClass = toSlug(nestedItem.state);
                                          const nestedTypeClass = toSlug(nestedItem.workItemType);
                                          return (
                                            <div
                                              key={nestedItem.id}
                                              role="button"
                                              tabIndex={0}
                                              className={`nested-item type-${nestedTypeClass}`}
                                              {...{ 'data-testid': `release-nested-item-${nestedItem.id}` }}
                                              onClick={() => onSelectItem?.(nestedItem)}
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter' || e.key === ' ') {
                                                  e.preventDefault();
                                                  onSelectItem?.(nestedItem);
                                                }
                                              }}
                                              title="Click to view details"
                                            >
                                              <div className="nested-item-main">
                                                <div className="nested-item-id">#{nestedItem.id}</div>
                                                <div className="nested-item-title">{nestedItem.title}</div>
                                                <span className={`nested-item-type type-${nestedTypeClass}`}>
                                                  {nestedItem.workItemType}
                                                </span>
                                                <span className={`nested-item-state state-${nestedStateClass}`}>
                                                  {nestedItem.state}
                                                </span>
                                              </div>
                                              {nestedItem.assignedTo && (
                                                <div className="nested-item-assignee">
                                                  <span className="nested-assignee-avatar">
                                                    {nestedItem.assignedTo.split(' ').map((n) => n[0]).join('').toUpperCase().substring(0, 2)}
                                                  </span>
                                                  <span className="nested-assignee-name">{nestedItem.assignedTo}</span>
                                                </div>
                                              )}
                                            </div>
                                          );
                                        })}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* New / Edit Release Modal */}
      {showReleaseModal && (
        <ReleaseFormModal
          isEditMode={Boolean(editingEpic)}
          project={project}
          currentAreaPath={areaPath}
          defaultValues={editingEpic ? {
            version: editingEpic.version,
            areaPath: editingEpic.areaPath || areaPath,
            startDate: editingEpic.startDate || '',
            targetDate: editingEpic.targetDate || '',
            description: editingEpic.description || '',
            status: editingEpic.status || 'New',
          } : undefined}
          submitError={formSubmitError}
          isSubmitting={isFormSubmitting}
          onSubmit={handleSubmitReleaseForm}
          onClose={handleCloseReleaseModal}
          {...{ 'data-testid': 'release-form-modal' }}
        />
      )}

      {/* Link Items Modal */}
      {showLinkItemsModal && (
        <div
          className="modal-overlay"
          {...{ 'data-testid': 'release-link-overlay' }}
          onClick={handleCloseLinkItemsModal}
        >
          <div
            className="modal-content modal-large"
            role="dialog"
            aria-modal="true"
            {...{ 'data-testid': 'release-link-modal' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Link Items to Release</h3>

            <div className="search-section">
              <div className="search-filters">
                <div className="form-group">
                  <label htmlFor="release-link-search-input">Search:</label>
                  <input
                    id="release-link-search-input"
                    type="text"
                    {...{ 'data-testid': 'release-link-search' }}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by ID, title, or keyword..."
                    className="search-input"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="release-link-type-select">Type:</label>
                  <select
                    id="release-link-type-select"
                    {...{ 'data-testid': 'release-link-type' }}
                    value={workItemTypeFilter}
                    onChange={(e) => setWorkItemTypeFilter(e.target.value)}
                    className="filter-select"
                  >
                    <option value="All">All Types</option>
                    <option value="Epic">Epic</option>
                    <option value="Feature">Feature</option>
                    <option value="Product Backlog Item">Product Backlog Item</option>
                    <option value="Technical Backlog Item">Technical Backlog Item</option>
                    <option value="Bug">Bug</option>
                  </select>
                </div>
              </div>

              <div className="search-results">
                {searchLoading ? (
                  <div className="search-loading">Searching...</div>
                ) : searchQuery.length < 2 ? (
                  <div className="search-hint">Enter at least 2 characters to search</div>
                ) : searchResults.length === 0 ? (
                  <div className="search-hint">No items found</div>
                ) : (
                  <div className="results-list">
                    <div className="results-header">
                      <span>{searchResults.length} items found</span>
                      <button
                        type="button"
                        className="btn-select-all"
                        {...{ 'data-testid': 'release-link-select-all' }}
                        onClick={() => {
                          if (selectedItemsToLink.length === searchResults.length) {
                            setSelectedItemsToLink([]);
                          } else {
                            setSelectedItemsToLink(searchResults.map((wi) => wi.id));
                          }
                        }}
                      >
                        {selectedItemsToLink.length === searchResults.length ? 'Deselect All' : 'Select All'}
                      </button>
                    </div>
                    {searchResults.map((item) => (
                      <div key={item.id} className="result-item">
                        <input
                          type="checkbox"
                          {...{ 'data-testid': `release-link-item-${item.id}` }}
                          checked={selectedItemsToLink.includes(item.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedItemsToLink([...selectedItemsToLink, item.id]);
                            } else {
                              setSelectedItemsToLink(selectedItemsToLink.filter((id) => id !== item.id));
                            }
                          }}
                        />
                        <div className="result-item-details">
                          <div className="result-item-header">
                            <span className="result-item-id">#{item.id}</span>
                            <span className="result-item-type">{item.workItemType}</span>
                            <span className={`result-item-state state-${toSlug(item.state)}`}>
                              {item.state}
                            </span>
                          </div>
                          <div className="result-item-title">{item.title}</div>
                          {item.assignedTo && (
                            <div className="result-item-assigned">Assigned to: {item.assignedTo}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="modal-actions">
              <button
                type="button"
                {...{ 'data-testid': 'release-link-submit' }}
                onClick={() => void handleLinkItems()}
                className="btn-primary"
                disabled={selectedItemsToLink.length === 0}
              >
                Link {selectedItemsToLink.length} Item{selectedItemsToLink.length !== 1 ? 's' : ''}
              </button>
              <button
                type="button"
                {...{ 'data-testid': 'release-link-cancel' }}
                onClick={handleCloseLinkItemsModal}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Outcome Modal */}
      {showOutcomeModal && outcomeReleaseVersion && (
        <DeploymentOutcomeModal
          {...{ 'data-testid': 'release-deployment-outcome-modal' } as Partial<React.ComponentProps<typeof DeploymentOutcomeModal>>}
          isOpen={showOutcomeModal}
          onClose={handleCloseOutcomeModal}
          releaseVersion={outcomeReleaseVersion}
          deployedAt={outcomeDeployedAt}
        />
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirmModal && deletingEpicId && (
        <div
          className="modal-overlay"
          {...{ 'data-testid': 'release-delete-overlay' }}
          onClick={() => !isDeleting && setShowDeleteConfirmModal(false)}
        >
          <div
            className="modal-content"
            role="dialog"
            aria-modal="true"
            {...{ 'data-testid': 'release-delete-modal' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>Confirm Delete Release Epic</h3>
              <button
                type="button"
                className="modal-close"
                {...{ 'data-testid': 'release-delete-close' }}
                onClick={() => setShowDeleteConfirmModal(false)}
                disabled={isDeleting}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="modal-icon-danger">🗑️</div>
              <p className="modal-message">
                Are you sure you want to delete this release epic?
              </p>
              <div className="modal-epic-info-delete">
                <span className="modal-epic-version">
                  {releaseEpics.find((e) => e.id === deletingEpicId)?.version}
                </span>
                <span className="modal-epic-id">
                  #{deletingEpicId}
                </span>
              </div>
              <div className="modal-warning-danger">
                ⚠️ <strong>Warning:</strong> This will permanently delete the epic and remove all hierarchical relationships with child work items. The child work items themselves will NOT be deleted, only the links to this epic.
              </div>
              <div className="modal-info">
                ℹ️ This action cannot be undone.
              </div>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="modal-btn modal-btn-cancel"
                {...{ 'data-testid': 'release-delete-cancel' }}
                onClick={() => setShowDeleteConfirmModal(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn modal-btn-danger"
                {...{ 'data-testid': 'release-delete-confirm' }}
                onClick={() => void handleDeleteReleaseEpic()}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Epic'}
              </button>
            </div>
          </div>
        </div>
      )}

      {cabModalEpic && (
        <CreateCabRequestModal
          {...{ 'data-testid': 'create-cab-request-modal' }}
          targetVersion={cabModalEpic.version}
          defaultPreviousBranch={defaultPreviousReleaseBranch(
            visibleEpics.map((epic) => epic.version),
            cabModalEpic.version,
          )}
          onCancel={dismissCabModal}
          onConfirm={(values) => { void handleConfirmCabRequest(cabModalEpic, values); }}
        />
      )}

      {cabPanel && (
        <CabReleaseAssistantPanel
          key={cabPanel.requestId}
          {...{ 'data-testid': 'cab-release-assistant-panel' }}
          onClose={() => setCabPanel(null)}
          project={project}
          targetVersion={cabPanel.version}
          apexReleaseEpicId={cabPanel.epicId}
          relatedWorkItemIds={cabPanel.relatedWorkItemIds}
          previousReleaseBranch={cabPanel.previousReleaseBranch}
          snowMode={cabPanel.snowMode}
          cutReleaseBranch={cabPanel.cutReleaseBranch}
        />
      )}
    </div>
  );
};

export default ReleaseView;
