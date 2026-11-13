import React, { useState, useEffect, useRef, useCallback } from 'react';
import { WorkItem, ReleaseMetrics } from '../types/workitem';
import { useDeploymentOutcomes } from '../hooks/useDeploymentOutcomes';
import type { DeploymentResult } from '../../shared/types/deploymentOutcome';
import { DeploymentOutcomeModal } from './DeploymentOutcomeModal';
import { DeploymentOutcomeReport } from './DeploymentOutcomeReport';
import { CreateCabRequestModal } from './CreateCabRequestModal';
import { CabReleaseAssistantPanel } from './CabReleaseAssistantPanel';
import { ReleaseCabRequestAction } from './ReleaseCabRequestAction';
import { ReleasePlatformModal } from './ReleasePlatformModal';
import { useAppShell } from '../hooks/useAppShell';
import { useReleasePlatforms } from '../hooks/useReleasePlatforms';
import { reorderReleases } from '../utils/releaseOrder';
import {
  computeExpandedPlatformSummaries,
  computeLifecycleCounts,
  computeSlatedReleasesOverview,
  filterExpandedWorkItems,
  filterReleaseEpics,
  getEpicValidationCounts,
  groupExpandedWorkItems,
  groupReleaseEpics,
  summarizeWorkItemsValidation,
  type ExpandedItemFilter,
  type ExpandedItemGroupBy,
  type ReleaseGroupBy,
  type ReleaseLifecycleFilter,
} from '../utils/releaseOrganization';
import {
  matchPlatformsFromTags,
  resolveReleaseEpicPlatforms,
  resolveWorkItemPlatforms,
} from '../../shared/types/releasePlatforms';
import {
  defaultPreviousReleaseBranch,
  type CreateCabRequestFormValues,
} from '../utils/cabReleaseKickoff';
import './ReleaseView.css';

const RENAMABLE_STATUSES = ['New', 'In Design', 'In Progress'] as const;
const SCROLL_EDGE_PX = 88;

function adjustReleaseEpicCounts(epic: any, item: WorkItem, direction: 1 | -1) {
  const greenStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
  const amberStates = ['UAT - Ready For Test', 'UAT Ready For Test', 'UAT-Ready For Test'];
  const bucket = greenStates.includes(item.state) ? 'green' : amberStates.includes(item.state) ? 'amber' : 'red';
  const totalItems = Math.max(0, (epic.totalItems ?? 0) + direction);
  const greenItems = Math.max(0, (epic.greenItems ?? 0) + (bucket === 'green' ? direction : 0));
  const amberItems = Math.max(0, (epic.amberItems ?? 0) + (bucket === 'amber' ? direction : 0));
  const redItems = Math.max(0, (epic.redItems ?? 0) + (bucket === 'red' ? direction : 0));
  let childItemsSummary = epic.childItemsSummary;
  if (Array.isArray(childItemsSummary)) {
    if (direction === -1) {
      childItemsSummary = childItemsSummary.filter((entry: { id: number }) => entry.id !== item.id);
    } else if (!childItemsSummary.some((entry: { id: number }) => entry.id === item.id)) {
      childItemsSummary = [
        ...childItemsSummary,
        {
          id: item.id,
          state: item.state,
          workItemType: item.workItemType,
          tags: item.tags ?? '',
        },
      ];
    }
  }
  return {
    ...epic,
    totalItems,
    greenItems,
    amberItems,
    redItems,
    completedItems: greenItems,
    progress: totalItems > 0 ? Math.round((greenItems / totalItems) * 100) : 0,
    ...(Array.isArray(childItemsSummary) ? { childItemsSummary } : {}),
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
  const outcomeSlug = releaseVersion.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';

  if (!outcomes || outcomes.length === 0) {
    return (
      <button
        type="button"
        className="result-badge result-none result-badge-button"
        {...{ 'data-testid': testId ?? `release-outcome-add-${outcomeSlug}` }}
        onClick={(e) => { e.stopPropagation(); onManage(releaseVersion, deployedAt); }}
        title="Add deployment outcome"
      >
        + Add
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
  const shell = useAppShell();
  const canManageReleases = Boolean(shell.permissionsLoaded && shell.isInAnyGroup?.(['BA']));

  const {
    platforms,
    epicPlatformIds,
    workItemPlatformIds,
    createPlatform,
    reorderPlatforms,
    deletePlatform,
    updateEpicPlatforms,
    updateWorkItemPlatforms,
  } = useReleasePlatforms(project);
  const hasConfiguredPlatforms = platforms.length > 0;

  const [, setReleases] = useState<string[]>([]);
  const [selectedRelease, setSelectedRelease] = useState<string | null>(null);
  const [releaseWorkItems, setReleaseWorkItems] = useState<WorkItem[]>([]);
  const [releaseMetrics, setReleaseMetrics] = useState<ReleaseMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [showNewReleaseModal, setShowNewReleaseModal] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingEpicId, setEditingEpicId] = useState<number | null>(null);
  const [newReleaseVersion, setNewReleaseVersion] = useState('');
  const [newReleaseStartDate, setNewReleaseStartDate] = useState('');
  const [newReleaseTargetDate, setNewReleaseTargetDate] = useState('');
  const [newReleaseDescription, setNewReleaseDescription] = useState('');
  const [newReleaseStatus, setNewReleaseStatus] = useState<string>('New');
  const [, setSelectedWorkItemsForRelease] = useState<number[]>([]);
  const [releaseEpics, setReleaseEpics] = useState<any[]>([]);
  const [loadingEpics, setLoadingEpics] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<number | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [childItems, setChildItems] = useState<Map<number, WorkItem[]>>(new Map());
  const [loadingChildren, setLoadingChildren] = useState<Set<number>>(new Set());
  const [showLinkItemsModal, setShowLinkItemsModal] = useState(false);
  const [linkingEpicId, setLinkingEpicId] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [workItemTypeFilter, setWorkItemTypeFilter] = useState('All');
  const [searchResults, setSearchResults] = useState<WorkItem[]>([]);
  const [selectedItemsToLink, setSelectedItemsToLink] = useState<number[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [deletingEpicId, setDeletingEpicId] = useState<number | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showProgressInfo, setShowProgressInfo] = useState(false);
  const [itemsWithUatReadyChildren, setItemsWithUatReadyChildren] = useState<Set<number>>(new Set());
  const [expandedNestedItems, setExpandedNestedItems] = useState<Set<string>>(new Set());
  const [nestedChildren, setNestedChildren] = useState<Map<number, WorkItem[]>>(new Map());
  const [loadingNestedChildren, setLoadingNestedChildren] = useState<Set<number>>(new Set());
  const [sortColumn, setSortColumn] = useState<string | null>('version');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
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
  const cabRequestGenerationRef = useRef(0);

  // Inline rename state
  const [inlineEditEpicId, setInlineEditEpicId] = useState<number | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [isSavingRename, setIsSavingRename] = useState(false);

  // Drag-to-reorder state
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const draggedReleaseItemRef = useRef<{ sourceEpicId: number; item: WorkItem } | null>(null);
  const releaseViewRef = useRef<HTMLDivElement>(null);
  const topEdgeRef = useRef<HTMLDivElement>(null);
  const bottomEdgeRef = useRef<HTMLDivElement>(null);
  const scrollDirectionRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const revealDropZonesFrameRef = useRef<number | null>(null);
  const ignoreCardClickRef = useRef(false);
  const [assignmentNotice, setAssignmentNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [movingItemId, setMovingItemId] = useState<number | null>(null);

  // Organization, platform management, and QA validation workspace state
  const [showPlatformsModal, setShowPlatformsModal] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState<ReleaseLifecycleFilter>('all');
  const [releaseGroupBy, setReleaseGroupBy] = useState<ReleaseGroupBy>('none');
  const [platformFilterSlug, setPlatformFilterSlug] = useState<string | null>(null);
  const [releaseSearchText, setReleaseSearchText] = useState('');
  const [collapsedReleaseGroups, setCollapsedReleaseGroups] = useState<Set<string>>(new Set());
  const [openEpicPlatformPopoverId, setOpenEpicPlatformPopoverId] = useState<number | null>(null);
  const [openItemPlatformPopoverKey, setOpenItemPlatformPopoverKey] = useState<string | null>(null);
  const [expandedItemFilterByEpic, setExpandedItemFilterByEpic] = useState<Record<number, ExpandedItemFilter>>({});
  const [expandedItemPlatformByEpic, setExpandedItemPlatformByEpic] = useState<Record<number, string | null>>({});
  const [expandedItemGroupByEpic, setExpandedItemGroupByEpic] = useState<Record<number, ExpandedItemGroupBy>>({});
  const [collapsedItemSections, setCollapsedItemSections] = useState<Set<string>>(new Set());

  // Reset platform filter / platform group-by when project changes or platforms are removed
  useEffect(() => {
    setPlatformFilterSlug(null);
    setOpenEpicPlatformPopoverId(null);
    setOpenItemPlatformPopoverKey(null);
  }, [project]);

  useEffect(() => {
    if (!hasConfiguredPlatforms) {
      if (platformFilterSlug !== null) setPlatformFilterSlug(null);
      if (releaseGroupBy === 'platform') setReleaseGroupBy('none');
    } else if (
      platformFilterSlug &&
      platformFilterSlug !== 'unassigned' &&
      !platforms.some((p) => p.slug === platformFilterSlug)
    ) {
      setPlatformFilterSlug(null);
    }
  }, [hasConfiguredPlatforms, platformFilterSlug, platforms, releaseGroupBy]);

  // Close platform popovers when clicking outside
  useEffect(() => {
    if (openEpicPlatformPopoverId === null && openItemPlatformPopoverKey === null) return;
    const handleDocClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        !target.closest('.release-row-platforms') &&
        !target.closest('.card-platform-popover-wrapper')
      ) {
        setOpenEpicPlatformPopoverId(null);
        setOpenItemPlatformPopoverKey(null);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    return () => document.removeEventListener('mousedown', handleDocClick);
  }, [openEpicPlatformPopoverId, openItemPlatformPopoverKey]);

  // Fetch all release versions on mount
  useEffect(() => {
    fetchReleases();
    fetchReleaseEpics();
  }, [project, areaPath]);

  // Close action menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.actions-cell')) {
        setOpenActionMenuId(null);
      }
    };

    if (openActionMenuId !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openActionMenuId]);

  const fetchReleaseEpics = async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (!background) setLoadingEpics(true);
    try {
      const response = await fetch(
        `/api/releases/epics?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );
      
      if (!response.ok) {
        console.error('Failed to fetch release epics:', response.status, response.statusText);
        if (!background) setReleaseEpics([]);
        return;
      }
      
      const data = await response.json();
      setReleaseEpics(data);
    } catch (error) {
      console.error('Error fetching release epics:', error);
      if (!background) setReleaseEpics([]);
    } finally {
      if (!background) setLoadingEpics(false);
    }
  };

  const searchWorkItems = async (query: string, typeFilter: string) => {
    if (!query || query.length < 2) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await fetch(
        `/api/workitems/search?query=${encodeURIComponent(query)}&type=${encodeURIComponent(typeFilter)}&project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );
      
      if (!response.ok) {
        console.error('Failed to search work items:', response.status);
        setSearchResults([]);
        return;
      }
      
      const data = await response.json();
      setSearchResults(data);
    } catch (error) {
      console.error('Error searching work items:', error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (showLinkItemsModal) {
        searchWorkItems(searchQuery, workItemTypeFilter);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [searchQuery, workItemTypeFilter, showLinkItemsModal]);

  // Fetch release details when selected release changes
  useEffect(() => {
    if (selectedRelease) {
      fetchReleaseDetails(selectedRelease);
    }
  }, [selectedRelease, project, areaPath]);

  const fetchReleases = async () => {
    try {
      const response = await fetch(
        `/api/releases?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );
      
      if (!response.ok) {
        console.error('Failed to fetch releases:', response.status, response.statusText);
        setReleases([]);
        return;
      }
      
      const data = await response.json();
      
      // Ensure data is an array
      if (Array.isArray(data)) {
        setReleases(data);
        if (data.length > 0 && !selectedRelease) {
          setSelectedRelease(data[0]);
        }
      } else {
        console.error('Releases data is not an array:', data);
        setReleases([]);
      }
    } catch (error) {
      console.error('Error fetching releases:', error);
      setReleases([]);
    }
  };

  const fetchReleaseDetails = async (version: string) => {
    setLoading(true);
    try {
      // Fetch work items for this release
      const workItemsResponse = await fetch(
        `/api/releases/${encodeURIComponent(version)}/workitems?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );
      const workItemsData = await workItemsResponse.json();
      setReleaseWorkItems(workItemsData);

      // Fetch metrics for this release
      const metricsResponse = await fetch(
        `/api/releases/${encodeURIComponent(version)}/metrics?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
      );
      const metricsData = await metricsResponse.json();
      setReleaseMetrics(metricsData);
    } catch (error) {
      console.error('Error fetching release details:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRelease = async () => {
    if (!newReleaseVersion) return;

    try {
      const response = await fetch(`/api/releases/${encodeURIComponent(newReleaseVersion)}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          areaPath,
          startDate: newReleaseStartDate || undefined,
          targetDate: newReleaseTargetDate || undefined,
          description: newReleaseDescription || undefined,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`Release Epic created with ID: ${data.epicId}`);
        handleCloseModal();
        fetchReleases();
        void fetchReleaseEpics({ background: true });
      }
    } catch (error) {
      console.error('Error creating release:', error);
    }
  };

  const handleUpdateRelease = async () => {
    if (!newReleaseVersion || !editingEpicId) return;

    try {
      const response = await fetch(`/api/releases/${editingEpicId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: newReleaseVersion,
          startDate: newReleaseStartDate || undefined,
          targetDate: newReleaseTargetDate || undefined,
          description: newReleaseDescription || undefined,
          status: newReleaseStatus,
          project,
          areaPath,
        }),
      });

      if (response.ok) {
        console.log(`Release Epic updated: ${editingEpicId}`);
        handleCloseModal();
        void fetchReleaseEpics({ background: true });
      }
    } catch (error) {
      console.error('Error updating release:', error);
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

  const handleOpenEditModal = (epic: any) => {
    setIsEditMode(true);
    setEditingEpicId(epic.id);
    setNewReleaseVersion(epic.version);
    setNewReleaseStartDate(epic.startDate || '');
    setNewReleaseTargetDate(epic.targetDate || '');
    setNewReleaseDescription(epic.description || '');
    setNewReleaseStatus(epic.status || 'New');
    setShowNewReleaseModal(true);
  };

  const handleCloseModal = () => {
    setShowNewReleaseModal(false);
    setIsEditMode(false);
    setEditingEpicId(null);
    setNewReleaseVersion('');
    setNewReleaseStartDate('');
    setNewReleaseTargetDate('');
    setNewReleaseDescription('');
    setNewReleaseStatus('New');
    setSelectedWorkItemsForRelease([]);
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

  const stopAutoScroll = () => {
    scrollDirectionRef.current = 0;
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  };

  const positionScrollEdges = () => {
    const scroller = findScrollParent(releaseViewRef.current);
    if (!scroller || !topEdgeRef.current || !bottomEdgeRef.current) return;
    const rect = scroller.getBoundingClientRect();
    for (const edge of [topEdgeRef.current, bottomEdgeRef.current]) {
      edge.style.left = `${rect.left}px`;
      edge.style.width = `${rect.width}px`;
    }
    topEdgeRef.current.style.top = `${rect.top}px`;
    bottomEdgeRef.current.style.top = `${rect.bottom - 48}px`;
  };

  const updateAutoScroll = (clientY: number) => {
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
  };

  const endCardDrag = () => {
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
  };

  const revealDropZones = (sourceEpicId: number) => {
    const view = releaseViewRef.current;
    if (!view || draggedReleaseItemRef.current?.sourceEpicId !== sourceEpicId) return;
    view.classList.add('is-moving-card');
    view.querySelectorAll<HTMLElement>('[data-release-drop]').forEach((row) => {
      row.classList.toggle('is-source', row.dataset.releaseDrop === String(sourceEpicId));
    });
    positionScrollEdges();
  };

  const beginCardDrag = (sourceEpicId: number, item: WorkItem, event: React.DragEvent<HTMLDivElement>) => {
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
  };

  const updateLocalReleaseAssignments = (targetEpicId: number, items: WorkItem[]) => {
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
  };

  const handleMoveReleaseItem = async (
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
  };

  const dropCardOnRelease = (targetEpicId: number, event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedItem = draggedReleaseItemRef.current;
    if (draggedItem && draggedItem.sourceEpicId !== targetEpicId) {
      void handleMoveReleaseItem(draggedItem.sourceEpicId, targetEpicId, draggedItem.item);
    }
    endCardDrag();
  };

  const handleUnlinkItem = async (epicId: number, workItemId: number) => {
    if (!confirm('Are you sure you want to unlink this item from the release?')) {
      return;
    }

    // Update local state to remove the item and keep epic counts aligned
    const existingItems = childItems.get(epicId) || [];
    const removedItem = existingItems.find((item) => item.id === workItemId);
    try {
      const response = await fetch(`/api/releases/${epicId}/unlink-related`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workItemIds: [workItemId],
          project,
          areaPath,
        }),
      });

      if (response.ok) {
        console.log(`Unlinked item ${workItemId} from epic ${epicId}`);
        setChildItems(prev => {
          const next = new Map(prev);
          const items = next.get(epicId) || [];
          next.set(epicId, items.filter(item => item.id !== workItemId));
          return next;
        });
        if (removedItem) {
          setReleaseEpics((previous) =>
            previous.map((epic) =>
              epic.id === epicId ? adjustReleaseEpicCounts(epic, removedItem, -1) : epic,
            ),
          );
        }
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

  const checkForUatReadyChildren = async (workItemId: number, workItemType: string) => {
    // Only check for Epics and Features
    if (workItemType !== 'Epic' && workItemType !== 'Feature') {
      return;
    }

    try {
      let endpoint = '';
      if (workItemType === 'Epic') {
        endpoint = `/api/epics/${workItemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
      } else if (workItemType === 'Feature') {
        endpoint = `/api/features/${workItemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
      }

      const response = await fetch(endpoint);
      if (response.ok) {
        const children = await response.json();
        // Check if any children are in UAT Ready for Test state
        const hasUatReady = children.some((child: WorkItem) => 
          child.state === 'UAT - Ready For Test' || 
          child.state === 'UAT Ready For Test' ||
          child.state === 'UAT-Ready For Test'
        );

        if (hasUatReady) {
          setItemsWithUatReadyChildren(prev => new Set(prev).add(workItemId));
        }
      }
    } catch (error) {
      console.error('Error checking for UAT-ready children:', error);
    }
  };

  const toggleNestedItemExpansion = async (epicId: number, itemId: number, workItemType: string) => {
    const cardKey = `${epicId}:${itemId}`;
    const newExpanded = new Set(expandedNestedItems);
    
    if (expandedNestedItems.has(cardKey)) {
      // Collapse
      newExpanded.delete(cardKey);
      setExpandedNestedItems(newExpanded);
    } else {
      // Expand
      newExpanded.add(cardKey);
      setExpandedNestedItems(newExpanded);
      
      // Fetch children if not already loaded
      if (!nestedChildren.has(itemId)) {
        setLoadingNestedChildren(prev => new Set(prev).add(itemId));
        
        try {
          let endpoint = '';
          if (workItemType === 'Epic') {
            endpoint = `/api/epics/${itemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
          } else if (workItemType === 'Feature') {
            endpoint = `/api/features/${itemId}/children?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`;
          }
          
          const response = await fetch(endpoint);
          if (response.ok) {
            const children = await response.json();
            setNestedChildren(prev => new Map(prev).set(itemId, children));
          }
        } catch (error) {
          console.error('Error fetching nested children:', error);
        } finally {
          setLoadingNestedChildren(prev => {
            const next = new Set(prev);
            next.delete(itemId);
            return next;
          });
        }
      }
    }
  };

  const handleDeleteReleaseEpic = async () => {
    if (!deletingEpicId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(`/api/releases/${deletingEpicId}?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        console.log(`Deleted epic ${deletingEpicId}`);
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

  const toggleRowExpansion = async (epicId: number) => {
    const newExpandedRows = new Set(expandedRows);
    
    if (expandedRows.has(epicId)) {
      // Collapse row
      newExpandedRows.delete(epicId);
      setExpandedRows(newExpandedRows);
    } else {
      // Expand row
      newExpandedRows.add(epicId);
      setExpandedRows(newExpandedRows);
      
      // Fetch child items if not already loaded
      if (!childItems.has(epicId)) {
        // Add to loading state
        setLoadingChildren(prev => {
          const next = new Set(prev);
          next.add(epicId);
          return next;
        });
        
        try {
          console.log(`Fetching related items for epic ${epicId}`);
          const response = await fetch(
            `/api/releases/${epicId}/related-items?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}`
          );
          
          if (response.ok) {
            const children = await response.json();
            console.log(`Received ${children.length} related items for epic ${epicId}`, children);
            
            // Update child items state
            setChildItems(prev => {
              const next = new Map(prev);
              next.set(epicId, children);
              return next;
            });
            
            // Check each child for UAT-ready descendants
            for (const child of children) {
              if (child.workItemType === 'Epic' || child.workItemType === 'Feature') {
                checkForUatReadyChildren(child.id, child.workItemType);
              }
            }
          } else {
            console.error(`Failed to fetch children: ${response.status} ${response.statusText}`);
          }
        } catch (error) {
          console.error('Error fetching child items:', error);
        } finally {
          // Remove from loading state
          setLoadingChildren(prev => {
            const next = new Set(prev);
            next.delete(epicId);
            return next;
          });
        }
      }
    }
  };

  const getHealthStatus = (): 'on-track' | 'at-risk' | 'blocked' => {
    if (!releaseMetrics) return 'on-track';
    
    if (releaseMetrics.blockedFeatures > 0) return 'blocked';
    
    const completionPct = calculateCompletionPercentage();
    if (completionPct < 50 && releaseMetrics.inProgressFeatures < releaseMetrics.totalFeatures * 0.5) {
      return 'at-risk';
    }
    return 'on-track';
  };

  const calculateCompletionPercentage = (): number => {
    if (!releaseMetrics || releaseMetrics.totalFeatures === 0) return 0;
    return Math.round((releaseMetrics.completedFeatures / releaseMetrics.totalFeatures) * 100);
  };

  const formatDate = (dateString?: string): string => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString();
  };

  const getStateClass = (state: string): string => {
    const completedStates = ['Ready For Release', 'UAT - Test Done', 'Done', 'Closed'];
    const inProgressStates = ['Committed', 'In Progress', 'Ready For Test', 'In Test', 'UAT - Ready For Test'];
    const blockedStates = ['Blocked'];

    if (completedStates.includes(state)) return 'state-completed';
    if (inProgressStates.includes(state)) return 'state-in-progress';
    if (blockedStates.includes(state)) return 'state-blocked';
    return 'state-not-started';
  };

  const downloadReleaseNotes = async (format: 'json' | 'markdown') => {
    if (!selectedRelease) return;

    try {
      const response = await fetch(
        `/api/releases/${encodeURIComponent(selectedRelease)}/notes?project=${encodeURIComponent(project)}&areaPath=${encodeURIComponent(areaPath)}&format=${format}`
      );
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `release-${selectedRelease}-notes.${format === 'markdown' ? 'md' : 'json'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Error downloading release notes:', error);
    }
  };

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  // ── Inline rename ──────────────────────────────────────────────────────────

  const startInlineEdit = useCallback((epic: any) => {
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
      // Refresh both epic list and tag-based release list
      fetchReleases();
      void fetchReleaseEpics({ background: true });
    } catch {
      setRenameError('An unexpected error occurred. Please try again.');
    } finally {
      setIsSavingRename(false);
    }
  }, [inlineEditValue, project, areaPath]);

  // ── Drag-to-reorder ────────────────────────────────────────────────────────

  const persistOrder = useCallback(async (orderedEpics: any[]) => {
    try {
      await fetch('/api/releases/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project,
          areaPath: areaPath ?? '',
          epicIds: orderedEpics.map((e: any) => e.id),
        }),
      });
    } catch (err) {
      console.error('[ReleaseView] Failed to persist release order:', err);
    }
  }, [project, areaPath]);

  const handleReorder = useCallback((fromIndex: number, toIndex: number) => {
    const reordered = reorderReleases(releaseEpics, fromIndex, toIndex);
    if (!reordered) return;
    setReleaseEpics(reordered);
    // Clear manual column sort so manual order is shown
    setSortColumn(null);
    void persistOrder(reordered);
  }, [releaseEpics, persistOrder]);

  const sortedEpics = React.useMemo(() => {
    if (!sortColumn) return releaseEpics;
    return [...releaseEpics].sort((a, b) => {
      let aVal: any;
      let bVal: any;
      switch (sortColumn) {
        case 'version':     aVal = a.version || '';     bVal = b.version || '';     break;
        case 'status':      aVal = a.status || '';      bVal = b.status || '';      break;
        case 'progress':    aVal = a.progress ?? 0;     bVal = b.progress ?? 0;     break;
        case 'startDate':   aVal = a.startDate || '';   bVal = b.startDate || '';   break;
        case 'targetDate':  aVal = a.targetDate || '';  bVal = b.targetDate || '';  break;
        case 'description': aVal = (a.description || '').replace(/<[^>]*>/g, ''); bVal = (b.description || '').replace(/<[^>]*>/g, ''); break;
        default: return 0;
      }
      if (typeof aVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  }, [releaseEpics, sortColumn, sortDirection]);

  const lifecycleCounts = React.useMemo(
    () => computeLifecycleCounts(releaseEpics),
    [releaseEpics],
  );

  const slatedOverview = React.useMemo(
    () =>
      computeSlatedReleasesOverview({
        epics: releaseEpics,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildrenByEpic: childItems,
      }),
    [releaseEpics, platforms, epicPlatformIds, workItemPlatformIds, childItems],
  );

  const filteredEpics = React.useMemo(
    () =>
      filterReleaseEpics({
        epics: sortedEpics,
        lifecycleFilter,
        platformFilterSlug,
        searchText: releaseSearchText,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildrenByEpic: childItems,
      }),
    [
      sortedEpics,
      lifecycleFilter,
      platformFilterSlug,
      releaseSearchText,
      platforms,
      epicPlatformIds,
      workItemPlatformIds,
      childItems,
    ],
  );

  const groupedEpics = React.useMemo(
    () =>
      groupReleaseEpics({
        epics: filteredEpics,
        groupBy: releaseGroupBy,
        platforms,
        epicPlatformIds,
        workItemPlatformIds,
        loadedChildrenByEpic: childItems,
      }),
    [
      filteredEpics,
      releaseGroupBy,
      platforms,
      epicPlatformIds,
      workItemPlatformIds,
      childItems,
    ],
  );

  const canDragReorderRows =
    canManageReleases &&
    sortColumn === null &&
    releaseGroupBy === 'none' &&
    lifecycleFilter === 'all' &&
    platformFilterSlug === null &&
    releaseSearchText.trim().length === 0;

  const toggleReleaseGroupCollapse = useCallback((groupKey: string) => {
    setCollapsedReleaseGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const toggleItemSectionCollapse = useCallback((sectionKey: string) => {
    setCollapsedItemSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) next.delete(sectionKey);
      else next.add(sectionKey);
      return next;
    });
  }, []);

  const handleToggleEpicPlatform = useCallback(
    async (epicId: number, platformId: string) => {
      const currentExplicit = epicPlatformIds[epicId] ?? [];
      const nextIds = currentExplicit.includes(platformId)
        ? currentExplicit.filter((id) => id !== platformId)
        : [...currentExplicit, platformId];
      try {
        await updateEpicPlatforms.mutateAsync({ epicId, platformIds: nextIds });
      } catch (err) {
        console.error('Failed to update release epic platforms:', err);
      }
    },
    [epicPlatformIds, updateEpicPlatforms],
  );

  const handleToggleWorkItemPlatform = useCallback(
    async (workItemId: number, platformId: string) => {
      const currentExplicit = workItemPlatformIds[workItemId] ?? [];
      const nextIds = currentExplicit.includes(platformId)
        ? currentExplicit.filter((id) => id !== platformId)
        : [...currentExplicit, platformId];
      try {
        await updateWorkItemPlatforms.mutateAsync({
          workItemId,
          platformIds: nextIds,
        });
      } catch (err) {
        console.error('Failed to update work item platforms:', err);
      }
    },
    [workItemPlatformIds, updateWorkItemPlatforms],
  );

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
      // Keep the expanded-row cache when the refresh fails.
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

  const healthStatus = getHealthStatus();
  const completionPercentage = calculateCompletionPercentage();

  useEffect(() => () => stopAutoScroll(), []);

  const columnCount =
    (canManageReleases ? 10 : 9) + (hasConfiguredPlatforms ? 1 : 0);

  const renderExpandedWorkItemCard = (epic: any, item: WorkItem) => {
    const stateClass = item.state.toLowerCase().replace(/\s+/g, '-');
    const typeClass = item.workItemType.toLowerCase().replace(/\s+/g, '-');
    const hasUatReadyChildren = itemsWithUatReadyChildren.has(item.id);
    const isExpandable = item.workItemType === 'Epic' || item.workItemType === 'Feature';
    const isExpanded = expandedNestedItems.has(`${epic.id}:${item.id}`);
    const itemPlatforms = resolveWorkItemPlatforms(item, platforms, workItemPlatformIds);
    const explicitItemIds = workItemPlatformIds[item.id] ?? [];
    const tagMatchedItemIds = matchPlatformsFromTags(item.tags, platforms);
    const popoverKey = `${epic.id}:${item.id}`;
    const isPlatformPopoverOpen = openItemPlatformPopoverKey === popoverKey;

    return (
      <React.Fragment key={item.id}>
        <div
          className={`child-item-card type-${typeClass}${hasUatReadyChildren ? ' has-uat-ready' : ''}${isExpanded ? ' expanded' : ''}${movingItemId === item.id ? ' moving' : ''}`}
          {...{ 'data-testid': `release-item-${epic.id}-${item.id}` }}
          draggable={canManageReleases && movingItemId === null}
          title={canManageReleases ? 'Drag to another release, or click to view details' : undefined}
          onDragStart={canManageReleases ? (event) => beginCardDrag(epic.id, item, event) : undefined}
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
              className="btn-expand-nested"
              {...{ 'data-testid': `release-item-expand-${epic.id}-${item.id}` }}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                toggleNestedItemExpansion(epic.id, item.id, item.workItemType);
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
            {...{ 'data-testid': `release-item-open-${epic.id}-${item.id}` }}
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

            {hasConfiguredPlatforms && (
              <div
                className="child-item-platforms-row"
                {...{ 'data-testid': `release-item-platforms-${epic.id}-${item.id}` }}
              >
                {itemPlatforms.length > 0 ? (
                  itemPlatforms.map((platform) => (
                    <span key={platform.id} className="platform-tag-badge">
                      <span className={`platform-color-dot platform-dot-${platform.color}`} />
                      <span>{platform.name}</span>
                    </span>
                  ))
                ) : (
                  <span className="platform-unassigned-text">Unassigned platform</span>
                )}
                {canManageReleases && (
                  <span className="card-platform-popover-wrapper">
                    <button
                      type="button"
                      className="platform-assign-trigger"
                      {...{ 'data-testid': `release-item-platform-btn-${epic.id}-${item.id}` }}
                      draggable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenItemPlatformPopoverKey(isPlatformPopoverOpen ? null : popoverKey);
                      }}
                      title="Assign target platforms"
                    >
                      + Platform
                    </button>
                    {isPlatformPopoverOpen && (
                      <div
                        className="platform-popover"
                        {...{ 'data-testid': `release-item-platform-popover-${epic.id}-${item.id}` }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="platform-popover-title">Target Platforms</div>
                        {platforms.map((platform) => {
                          const isExplicit = explicitItemIds.includes(platform.id);
                          const isFromTag = tagMatchedItemIds.includes(platform.id);
                          const isSelected = isExplicit || isFromTag;
                          return (
                            <button
                              key={platform.id}
                              type="button"
                              draggable={false}
                              className={`platform-popover-option${isSelected ? ' selected' : ''}`}
                              {...{
                                'data-testid': `release-item-platform-opt-${epic.id}-${item.id}-${platform.slug}`,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleToggleWorkItemPlatform(item.id, platform.id);
                              }}
                            >
                              <span>{isSelected ? '☑' : '☐'}</span>
                              <span className={`platform-color-dot platform-dot-${platform.color}`} />
                              <span>
                                {platform.name}
                                {isFromTag && !isExplicit ? ' (ADO tag)' : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </span>
                )}
              </div>
            )}

            <div className="child-item-footer">
              <div className="footer-left">
                {item.assignedTo ? (
                  <div className="child-item-assignee">
                    <span className="assignee-avatar">
                      {item.assignedTo.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2)}
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
                className="btn-unlink-item"
                {...{ 'data-testid': `release-item-unlink-${epic.id}-${item.id}` }}
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnlinkItem(epic.id, item.id);
                }}
                title="Unlink from release"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Nested children for Epic/Feature */}
          {isExpanded && (
            <div className="nested-children-container">
              {loadingNestedChildren.has(item.id) ? (
                <div className="nested-loading">
                  <div className="loading-spinner"></div>
                  <span>Loading child items...</span>
                </div>
              ) : nestedChildren.get(item.id)?.length === 0 ? (
                <div className="nested-empty">
                  <span>No child items found</span>
                </div>
              ) : (
                <div className="nested-items-list">
                  {nestedChildren.get(item.id)?.map((nestedItem) => {
                    const nestedStateClass = nestedItem.state.toLowerCase().replace(/\s+/g, '-');
                    const nestedTypeClass = nestedItem.workItemType.toLowerCase().replace(/\s+/g, '-');

                    return (
                      <div
                        key={nestedItem.id}
                        className={`nested-item type-${nestedTypeClass}`}
                        {...{ 'data-testid': `release-nested-item-${nestedItem.id}` }}
                        onClick={() => onSelectItem && onSelectItem(nestedItem)}
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
                              {nestedItem.assignedTo.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2)}
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
      </React.Fragment>
    );
  };

  const renderReleaseEpicRow = (epic: any, epicIndex: number) => {
    const epicCounts = getEpicValidationCounts(epic);
    const loadedEpicChildren = childItems.get(epic.id);
    const resolvedEpicPlatforms = resolveReleaseEpicPlatforms(
      epic,
      platforms,
      epicPlatformIds,
      workItemPlatformIds,
      loadedEpicChildren,
    );
    const explicitEpicPlatformIds = epicPlatformIds[epic.id] ?? [];
    const isEpicPlatformPopoverOpen = openEpicPlatformPopoverId === epic.id;

    const activeItemFilter: ExpandedItemFilter =
      expandedItemFilterByEpic[epic.id] ?? 'all';
    const activeItemPlatformSlug: string | null =
      expandedItemPlatformByEpic[epic.id] ?? null;
    const rawItemGroupBy: ExpandedItemGroupBy =
      expandedItemGroupByEpic[epic.id] ?? 'none';
    const activeItemGroupBy: ExpandedItemGroupBy =
      rawItemGroupBy === 'platform' && !hasConfiguredPlatforms
        ? 'none'
        : rawItemGroupBy;

    const expandedItems = loadedEpicChildren ?? [];
    const expandedItemsSummary = summarizeWorkItemsValidation(expandedItems);
    const expandedPlatformSummaries = computeExpandedPlatformSummaries({
      items: expandedItems,
      platforms,
      workItemPlatformIds,
    });
    const visibleExpandedItems = filterExpandedWorkItems({
      items: expandedItems,
      bucketFilter: activeItemFilter,
      platformSlugFilter: activeItemPlatformSlug,
      platforms,
      workItemPlatformIds,
    });
    const groupedExpandedSections = groupExpandedWorkItems({
      items: visibleExpandedItems,
      groupBy: activeItemGroupBy,
      platforms,
      workItemPlatformIds,
    });

    return (
      <React.Fragment key={epic.id}>
        <tr
          onDragOver={canManageReleases ? (e) => {
            const draggedItem = draggedReleaseItemRef.current;
            if (draggedItem) {
              if (draggedItem.sourceEpicId === epic.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              updateAutoScroll(e.clientY);
              return;
            }
            if (canDragReorderRows) {
              e.preventDefault();
              setDropTargetIndex(epicIndex);
            }
          } : undefined}
          onDrop={canManageReleases ? (e) => {
            if (draggedReleaseItemRef.current) {
              dropCardOnRelease(epic.id, e);
              return;
            }
            e.preventDefault();
            const from = dragIndexRef.current;
            if (canDragReorderRows && from !== null && from !== epicIndex) {
              handleReorder(from, epicIndex);
            }
            dragIndexRef.current = null;
            setDragIndex(null);
            setDropTargetIndex(null);
          } : undefined}
          className={[
            dragIndex === epicIndex ? 'row-dragging' : '',
            dropTargetIndex === epicIndex && dragIndex !== null && dragIndex !== epicIndex ? 'row-drop-target' : '',
          ].filter(Boolean).join(' ') || undefined}
        >
          {canManageReleases && (
            <td className="drag-handle-cell">
              {canDragReorderRows ? (
                <span
                  className="drag-handle"
                  title="Drag to reorder"
                  draggable
                  onDragStart={(event) => {
                    event.stopPropagation();
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData?.('text/plain', `release-order:${epic.id}`);
                    dragIndexRef.current = epicIndex;
                    setDragIndex(epicIndex);
                  }}
                  onDragEnd={() => {
                    dragIndexRef.current = null;
                    setDragIndex(null);
                    setDropTargetIndex(null);
                  }}
                >⠿</span>
              ) : (
                <span
                  className="drag-handle drag-handle-disabled"
                  title="Clear column sort and filters to enable drag ordering"
                >⠿</span>
              )}
            </td>
          )}
          <td>
            <button
              className="btn-expand"
              {...{ 'data-testid': `release-expand-${epic.id}` }}
              onClick={() => toggleRowExpansion(epic.id)}
              title={expandedRows.has(epic.id) ? 'Collapse' : 'Expand'}
            >
              {expandedRows.has(epic.id) ? '▼' : '▶'}
            </button>
          </td>
          <td className="version-cell">
            {inlineEditEpicId === epic.id ? (
              <span className="inline-rename-wrapper">
                <input
                  className="inline-rename-input"
                  {...{ 'data-testid': `release-rename-input-${epic.id}` }}
                  value={inlineEditValue}
                  autoFocus
                  onChange={(e) => setInlineEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { void commitRename(epic.id); }
                    if (e.key === 'Escape') { cancelInlineEdit(); }
                  }}
                  onBlur={() => { void commitRename(epic.id); }}
                  disabled={isSavingRename}
                />
                {renameError && <span className="rename-error">{renameError}</span>}
              </span>
            ) : (
              <span
                className={canManageReleases && (RENAMABLE_STATUSES as readonly string[]).includes(epic.status) ? 'version-editable' : undefined}
                {...{ 'data-testid': `release-rename-${epic.id}` }}
                title={canManageReleases && (RENAMABLE_STATUSES as readonly string[]).includes(epic.status) ? 'Click to rename' : undefined}
                onClick={canManageReleases && (RENAMABLE_STATUSES as readonly string[]).includes(epic.status) ? () => startInlineEdit(epic) : undefined}
              >
                {epic.version}
                {canManageReleases && (RENAMABLE_STATUSES as readonly string[]).includes(epic.status) && (
                  <span className="edit-pencil" aria-hidden>✎</span>
                )}
              </span>
            )}
          </td>
          {hasConfiguredPlatforms && (
            <td>
              <div
                className="release-row-platforms"
                {...{ 'data-testid': `release-row-platforms-${epic.id}` }}
              >
                {resolvedEpicPlatforms.length > 0 ? (
                  resolvedEpicPlatforms.map((platform) => (
                    <span key={platform.id} className="platform-tag-badge">
                      <span className={`platform-color-dot platform-dot-${platform.color}`} />
                      <span>{platform.name}</span>
                    </span>
                  ))
                ) : (
                  <span className="platform-unassigned-text">Unassigned</span>
                )}
                {canManageReleases && (
                  <>
                    <button
                      type="button"
                      className="platform-assign-trigger"
                      {...{ 'data-testid': `release-row-platform-btn-${epic.id}` }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenEpicPlatformPopoverId(
                          isEpicPlatformPopoverOpen ? null : epic.id,
                        );
                      }}
                      title="Set target platforms for release"
                    >
                      +
                    </button>
                    {isEpicPlatformPopoverOpen && (
                      <div
                        className="platform-popover"
                        {...{ 'data-testid': `release-row-platform-popover-${epic.id}` }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="platform-popover-title">Release Platforms</div>
                        {platforms.map((platform) => {
                          const isExplicit = explicitEpicPlatformIds.includes(platform.id);
                          const isResolved = resolvedEpicPlatforms.some((p) => p.id === platform.id);
                          return (
                            <button
                              key={platform.id}
                              type="button"
                              className={`platform-popover-option${isResolved ? ' selected' : ''}`}
                              {...{
                                'data-testid': `release-row-platform-opt-${epic.id}-${platform.slug}`,
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleToggleEpicPlatform(epic.id, platform.id);
                              }}
                            >
                              <span>{isExplicit ? '☑' : isResolved ? '◐' : '☐'}</span>
                              <span className={`platform-color-dot platform-dot-${platform.color}`} />
                              <span>
                                {platform.name}
                                {!isExplicit && isResolved ? ' (via items)' : ''}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </td>
          )}
          <td>
            <span className={`status-badge status-${epic.status.toLowerCase().replace(/\s+/g, '-')}`}>
              {epic.status}
            </span>
          </td>
          <td>
            <div className="progress-cell-stack">
              <div className="progress-cell">
                <div className="progress-bar-container">
                  {epicCounts.totalItems > 0 && (
                    <>
                      <div
                        className="progress-bar-segment segment-green"
                        style={{ width: `${(epicCounts.greenItems / epicCounts.totalItems) * 100}%` }}
                        title={`Ready: ${epicCounts.greenItems}`}
                      ></div>
                      <div
                        className="progress-bar-segment segment-amber"
                        style={{ width: `${(epicCounts.amberItems / epicCounts.totalItems) * 100}%` }}
                        title={`UAT Ready for Test: ${epicCounts.amberItems}`}
                      ></div>
                      <div
                        className="progress-bar-segment segment-red"
                        style={{ width: `${(epicCounts.redItems / epicCounts.totalItems) * 100}%` }}
                        title={`Other: ${epicCounts.redItems}`}
                      ></div>
                    </>
                  )}
                </div>
                <span className="progress-text">{epicCounts.completionPercent}%</span>
                <span className="progress-details">({epicCounts.greenItems}/{epicCounts.totalItems} items)</span>
              </div>
              <div
                className="release-remaining-row"
                {...{ 'data-testid': `release-remaining-badge-${epic.id}` }}
              >
                {epicCounts.totalItems === 0 ? (
                  <span className="remaining-badge">No items linked</span>
                ) : epicCounts.leftToValidate === 0 ? (
                  <span className="remaining-badge all-validated">✓ All validated</span>
                ) : (
                  <>
                    <span className="remaining-badge has-remaining">
                      {epicCounts.leftToValidate} left
                    </span>
                    {epicCounts.amberItems > 0 && (
                      <span className="remaining-uat-subbadge">
                        {epicCounts.amberItems} UAT ready
                      </span>
                    )}
                    {epicCounts.redItems > 0 && (
                      <span className="remaining-dev-subbadge">
                        {epicCounts.redItems} in dev
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
          </td>
          <td>{epic.startDate || 'N/A'}</td>
          <td>{epic.targetDate || 'N/A'}</td>
          <td className="description-cell">
            <div className="description-truncate" title={epic.description}>
              {epic.description ? epic.description.replace(/<[^>]*>/g, '').substring(0, 100) : 'N/A'}
              {epic.description && epic.description.length > 100 ? '...' : ''}
            </div>
          </td>
          <td>
            <OutcomeBadge {...{ 'data-testid': `release-outcome-badge-${epic.id}` }} releaseVersion={epic.version} deployedAt={epic.targetDate || undefined} onManage={handleOpenOutcomeModal} />
          </td>
          <td>
            <div className="actions-cell">
              <button
                className="btn-action-menu"
                {...{ 'data-testid': `release-actions-${epic.id}` }}
                onClick={() => setOpenActionMenuId(openActionMenuId === epic.id ? null : epic.id)}
                title="Actions"
              >
                ⋯
              </button>
              {openActionMenuId === epic.id && (
                <div className="action-dropdown">
                  <button
                    className="action-menu-item"
                    {...{ 'data-testid': `release-action-edit-${epic.id}` }}
                    onClick={() => {
                      handleOpenEditModal(epic);
                      setOpenActionMenuId(null);
                    }}
                  >
                    ✏️ Edit
                  </button>
                  <button
                    className="action-menu-item"
                    {...{ 'data-testid': `release-action-link-${epic.id}` }}
                    onClick={() => {
                      handleOpenLinkItemsModal(epic.id);
                      setOpenActionMenuId(null);
                    }}
                  >
                    🔗 Link Items
                  </button>
                  <button
                    className="action-menu-item"
                    {...{ 'data-testid': `release-action-outcome-${epic.id}` }}
                    onClick={() => {
                      handleOpenOutcomeModal(epic.version, epic.targetDate || undefined);
                      setOpenActionMenuId(null);
                    }}
                  >
                    📊 Deployment Outcome
                  </button>
                  <ReleaseCabRequestAction
                    project={project}
                    onClick={() => {
                      setCabModalEpic({ id: epic.id, version: epic.version });
                      setOpenActionMenuId(null);
                    }}
                    {...{ 'data-testid': `release-create-cab-${epic.id}` }}
                  />
                  <button
                    className="action-menu-item"
                    {...{ 'data-testid': `release-action-changelog-${epic.id}` }}
                    onClick={() => {
                      console.log('Create changelog for:', epic.id);
                      setOpenActionMenuId(null);
                    }}
                  >
                    📝 Create Changelog
                  </button>
                  <button
                    className="action-menu-item"
                    {...{ 'data-testid': `release-action-delete-${epic.id}` }}
                    onClick={() => {
                      setDeletingEpicId(epic.id);
                      setShowDeleteConfirmModal(true);
                      setOpenActionMenuId(null);
                    }}
                  >
                    🗑️ Delete
                  </button>
                </div>
              )}
            </div>
          </td>
        </tr>
        {canManageReleases && (
          <tr className="release-item-drop-row" data-release-drop={epic.id}>
            <td colSpan={columnCount}>
              <div
                className="release-item-drop-zone"
                onDragEnter={(event) => {
                  event.preventDefault();
                  releaseViewRef.current?.querySelectorAll('.release-item-drop-zone.active').forEach((zone) => {
                    zone.classList.remove('active');
                  });
                  event.currentTarget.classList.add('active');
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = 'move';
                  updateAutoScroll(event.clientY);
                }}
                onDrop={(event) => dropCardOnRelease(epic.id, event)}
              >
                Drop here to add to {epic.version}
              </div>
            </td>
          </tr>
        )}
        {expandedRows.has(epic.id) && (
          <tr className="expanded-row">
            <td colSpan={columnCount}>
              <div className="expanded-content">
                <div className="expanded-header">
                  <div className="expanded-title">
                    <span className="expanded-icon">📦</span>
                    <h4>Associated Work Items</h4>
                    <span className="expanded-count">{epicCounts.greenItems}/{epicCounts.totalItems} completed</span>
                  </div>
                  <div className="expanded-stats">
                    <div className="stat-badge">
                      <span className="stat-label">Progress</span>
                      <span className="stat-value">{epicCounts.completionPercent}%</span>
                    </div>
                  </div>
                </div>

                {loadingChildren.has(epic.id) ? (
                  <div className="child-loading">
                    <div className="loading-spinner"></div>
                    <span>Loading work items...</span>
                  </div>
                ) : expandedItems.length === 0 ? (
                  <div className="child-empty">
                    <div className="empty-icon">📋</div>
                    <div className="empty-text">No items linked to this release yet</div>
                    <div className="empty-hint">Click &quot;Link Items&quot; to add work items to this release</div>
                  </div>
                ) : (
                  <>
                    <div
                      className="expanded-readiness-strip"
                      {...{ 'data-testid': `release-expanded-overview-${epic.id}` }}
                    >
                      <div className="expanded-strip-top">
                        <div className="expanded-bucket-pills">
                          {(
                            [
                              { id: 'all' as const, label: `All (${expandedItemsSummary.totalItems})` },
                              {
                                id: 'left-to-validate' as const,
                                label: `Left to Validate (${expandedItemsSummary.leftToValidate})`,
                              },
                              {
                                id: 'uat-ready' as const,
                                label: `UAT Ready (${expandedItemsSummary.amberItems})`,
                              },
                              {
                                id: 'in-dev' as const,
                                label: `In Dev (${expandedItemsSummary.redItems})`,
                              },
                              {
                                id: 'validated' as const,
                                label: `Validated (${expandedItemsSummary.greenItems})`,
                              },
                            ] as const
                          ).map((pill) => (
                            <button
                              key={pill.id}
                              type="button"
                              className={`filter-pill-btn${activeItemFilter === pill.id ? ' active' : ''}`}
                              {...{ 'data-testid': `release-item-filter-${epic.id}-${pill.id}` }}
                              onClick={() =>
                                setExpandedItemFilterByEpic((prev) => ({
                                  ...prev,
                                  [epic.id]: pill.id,
                                }))
                              }
                            >
                              {pill.label}
                            </button>
                          ))}
                        </div>

                        <div className="toolbar-control-group">
                          <label htmlFor={`release-item-group-by-${epic.id}`}>Group Items:</label>
                          <select
                            id={`release-item-group-by-${epic.id}`}
                            className="toolbar-select"
                            {...{ 'data-testid': `release-item-group-by-${epic.id}` }}
                            value={activeItemGroupBy}
                            onChange={(e) =>
                              setExpandedItemGroupByEpic((prev) => ({
                                ...prev,
                                [epic.id]: e.target.value as ExpandedItemGroupBy,
                              }))
                            }
                          >
                            <option value="none">All Cards</option>
                            <option value="validation">Validation Status</option>
                            {hasConfiguredPlatforms && <option value="platform">Platform</option>}
                            <option value="type">Work Item Type</option>
                          </select>
                        </div>
                      </div>

                      {hasConfiguredPlatforms && (
                        <div className="expanded-platform-pills">
                          <button
                            type="button"
                            className={`expanded-platform-pill${activeItemPlatformSlug === null ? ' active' : ''}`}
                            {...{ 'data-testid': `release-expanded-platform-${epic.id}-all` }}
                            onClick={() =>
                              setExpandedItemPlatformByEpic((prev) => ({
                                ...prev,
                                [epic.id]: null,
                              }))
                            }
                          >
                            All Platforms ({expandedItems.length})
                          </button>
                          {expandedPlatformSummaries.map((ps) => {
                            const isSelected = activeItemPlatformSlug === ps.platform.slug;
                            return (
                              <button
                                key={ps.platform.id}
                                type="button"
                                className={`expanded-platform-pill${isSelected ? ' active' : ''}`}
                                {...{
                                  'data-testid': `release-expanded-platform-${epic.id}-${ps.platform.slug}`,
                                }}
                                onClick={() =>
                                  setExpandedItemPlatformByEpic((prev) => ({
                                    ...prev,
                                    [epic.id]: isSelected ? null : ps.platform.slug,
                                  }))
                                }
                              >
                                <span
                                  className={`platform-color-dot platform-dot-${ps.platform.color}`}
                                />
                                <span>
                                  {ps.platform.name}: {ps.greenItems}/{ps.totalItems} ready ·{' '}
                                  {ps.leftToValidate} left
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {visibleExpandedItems.length === 0 ? (
                      <div className="child-empty" {...{ 'data-testid': `release-expanded-filtered-empty-${epic.id}` }}>
                        <div className="empty-text">No work items match the selected filter</div>
                      </div>
                    ) : activeItemGroupBy === 'none' ? (
                      <div className="child-items-grid">
                        {visibleExpandedItems.map((item) => renderExpandedWorkItemCard(epic, item))}
                      </div>
                    ) : (
                      <div className="item-group-sections">
                        {groupedExpandedSections.map((section) => {
                          const collapseKey = `${epic.id}:${section.key}`;
                          const isCollapsed = collapsedItemSections.has(collapseKey);
                          return (
                            <div
                              key={section.key}
                              className="item-group-section"
                              {...{
                                'data-testid': `release-item-section-${epic.id}-${section.key}`,
                              }}
                            >
                              <button
                                type="button"
                                className="item-group-section-header"
                                {...{
                                  'data-testid': `release-item-section-toggle-${epic.id}-${section.key}`,
                                }}
                                onClick={() => toggleItemSectionCollapse(collapseKey)}
                              >
                                <span>
                                  {isCollapsed ? '▶' : '▼'} {section.label} ({section.totalItems})
                                </span>
                                <span>
                                  {section.completionPercent}% validated · {section.leftToValidate}{' '}
                                  left to validate
                                </span>
                              </button>
                              {!isCollapsed && (
                                <div className="item-group-section-body">
                                  <div className="child-items-grid">
                                    {section.items.map((item) =>
                                      renderExpandedWorkItemCard(epic, item),
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </div>
            </td>
          </tr>
        )}
      </React.Fragment>
    );
  };

  return (
    <div
      className="release-view"
      ref={releaseViewRef}
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
              <div
                className="info-icon"
                {...{ 'data-testid': 'release-progress-info' }}
                onClick={() => setShowProgressInfo(!showProgressInfo)}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                  <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
                </svg>
              </div>
              {showProgressInfo && (
                <div className="progress-info-tooltip">
                  <div className="tooltip-header">
                    <h4>Progress Calculation</h4>
                    <button
                      className="btn-close-tooltip"
                      {...{ 'data-testid': 'release-progress-info-close' }}
                      onClick={() => setShowProgressInfo(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="tooltip-content">
                    <p>The progress bar shows a color-coded breakdown of work item states:</p>
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
                        <span className="calc-label">All other states</span>
                      </div>
                    </div>
                    <p className="tooltip-note">
                      The completion percentage reflects only <strong>green</strong> items (fully complete).<br/>
                      Amber indicates items in UAT awaiting testing. Red indicates items still in progress or not started.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="release-actions">
            {canManageReleases && (
              <button
                type="button"
                className="btn-manage-platforms"
                {...{ 'data-testid': 'release-manage-platforms-btn' }}
                onClick={() => setShowPlatformsModal(true)}
              >
                Manage Platforms{hasConfiguredPlatforms ? ` (${platforms.length})` : ''}
              </button>
            )}
            <button
              className="btn-view-report"
              {...{ 'data-testid': 'release-view-report' }}
              onClick={() => setShowReport(!showReport)}
            >
              {showReport ? '← Back to Releases' : 'View Report'}
            </button>
            <button
              className="btn-create-release"
              {...{ 'data-testid': 'release-create' }}
              onClick={() => setShowNewReleaseModal(true)}
            >
              + New Release
            </button>
          </div>
        </div>
      </div>

      {assignmentNotice && (
        <div className={`release-assignment-notice ${assignmentNotice.kind}`} role="status">
          <span>{assignmentNotice.text}</span>
          <button type="button" {...{ 'data-testid': 'release-assignment-dismiss' }} onClick={() => setAssignmentNotice(null)} aria-label="Dismiss message">✕</button>
        </div>
      )}

      {showReport ? (
        <DeploymentOutcomeReport onClose={() => setShowReport(false)} />
      ) : (
      <>
      {!loadingEpics && releaseEpics.length > 0 && (
        <>
          {/* REQ-4: Slated Release Executive & QA Overview */}
          <section
            className="release-slated-overview"
            {...{ 'data-testid': 'release-slated-overview' }}
            aria-label="Slated Releases Overview"
          >
            <div className="slated-overview-header">
              <div className="slated-overview-title-group">
                <h3 className="slated-overview-title">Slated Release Overview</h3>
                <span className="slated-overview-subtitle">
                  Active and upcoming unshipped releases — readiness &amp; remaining QA validation
                </span>
              </div>
              {!hasConfiguredPlatforms && canManageReleases && (
                <span className="slated-unconfigured-hint">
                  Shipping to multiple targets?
                  <button
                    type="button"
                    className="slated-unconfigured-link"
                    {...{ 'data-testid': 'release-configure-platforms-inline' }}
                    onClick={() => setShowPlatformsModal(true)}
                  >
                    Configure Target Platforms
                  </button>
                </span>
              )}
            </div>

            <div className="slated-kpi-grid">
              <div className="slated-kpi-card" {...{ 'data-testid': 'slated-releases-count' }}>
                <span className="slated-kpi-label">Slated Releases</span>
                <div className="slated-kpi-value-row">
                  <span className="slated-kpi-value">{slatedOverview.slatedReleaseCount}</span>
                  {slatedOverview.overdueCount > 0 && (
                    <span className="slated-overdue-pill" {...{ 'data-testid': 'slated-overdue-count' }}>
                      {slatedOverview.overdueCount} overdue / at risk
                    </span>
                  )}
                </div>
                <span className="slated-kpi-meta">
                  {slatedOverview.nearestTargetDate
                    ? `Next target: ${slatedOverview.nearestTargetDate} (${slatedOverview.nearestReleaseVersion})`
                    : 'No upcoming target date set'}
                </span>
              </div>

              <div className="slated-kpi-card" {...{ 'data-testid': 'slated-overall-progress' }}>
                <span className="slated-kpi-label">Slated Validation Progress</span>
                <div className="slated-kpi-value-row">
                  <span className="slated-kpi-value">{slatedOverview.completionPercent}%</span>
                  <span className="slated-kpi-meta">
                    ({slatedOverview.greenItems}/{slatedOverview.totalItems} validated)
                  </span>
                </div>
                <div className="progress-bar-container">
                  {slatedOverview.totalItems > 0 && (
                    <>
                      <div
                        className="progress-bar-segment segment-green"
                        style={{
                          width: `${(slatedOverview.greenItems / slatedOverview.totalItems) * 100}%`,
                        }}
                      />
                      <div
                        className="progress-bar-segment segment-amber"
                        style={{
                          width: `${(slatedOverview.amberItems / slatedOverview.totalItems) * 100}%`,
                        }}
                      />
                      <div
                        className="progress-bar-segment segment-red"
                        style={{
                          width: `${(slatedOverview.redItems / slatedOverview.totalItems) * 100}%`,
                        }}
                      />
                    </>
                  )}
                </div>
              </div>

              <div className="slated-kpi-card" {...{ 'data-testid': 'slated-left-to-validate' }}>
                <span className="slated-kpi-label">What&apos;s Left to Validate</span>
                <div className="slated-kpi-value-row">
                  <span className="slated-kpi-value">{slatedOverview.leftToValidate}</span>
                  <span className="slated-kpi-meta">items remaining across slated releases</span>
                </div>
                <div className="slated-validation-pills">
                  <span className="validation-mini-pill pill-amber">
                    ● {slatedOverview.amberItems} UAT ready now
                  </span>
                  <span className="validation-mini-pill pill-red">
                    ○ {slatedOverview.redItems} in dev
                  </span>
                  <span className="validation-mini-pill pill-green">
                    ✓ {slatedOverview.greenItems} validated
                  </span>
                </div>
              </div>
            </div>

            {hasConfiguredPlatforms && (
              <div
                className="slated-platform-matrix"
                {...{ 'data-testid': 'slated-platform-breakdown' }}
              >
                <span className="slated-platform-matrix-label">
                  Target Platform Readiness (click to filter releases)
                </span>
                <div className="slated-platform-cards">
                  {slatedOverview.platformReadiness.map((entry) => {
                    const isActive = platformFilterSlug === entry.platform.slug;
                    return (
                      <button
                        key={entry.platform.id}
                        type="button"
                        className={`slated-platform-chip${isActive ? ' active' : ''}`}
                        {...{ 'data-testid': `slated-platform-chip-${entry.platform.slug}` }}
                        onClick={() =>
                          setPlatformFilterSlug(isActive ? null : entry.platform.slug)
                        }
                      >
                        <div className="slated-platform-chip-top">
                          <span className="slated-platform-name">
                            <span
                              className={`platform-color-dot platform-dot-${entry.platform.color}`}
                            />
                            <span>{entry.platform.name}</span>
                          </span>
                          <span className="slated-platform-pct">{entry.completionPercent}%</span>
                        </div>
                        <div className="slated-platform-chip-meta">
                          <span>
                            {entry.slatedReleaseCount} slated release
                            {entry.slatedReleaseCount === 1 ? '' : 's'}
                          </span>
                          <span className="slated-platform-left">
                            {entry.leftToValidate} left to validate
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </section>

          {/* REQ-5: Organization & Filter Toolbar */}
          <div
            className="release-organization-toolbar"
            {...{ 'data-testid': 'release-organization-toolbar' }}
          >
            <div className="toolbar-primary-row">
              <div className="lifecycle-pills" role="group" aria-label="Filter releases by lifecycle">
                {(
                  [
                    { mode: 'all' as const, label: 'All' },
                    { mode: 'slated' as const, label: 'Slated' },
                    { mode: 'in-flight' as const, label: 'In Flight' },
                    { mode: 'planned' as const, label: 'Planned' },
                    { mode: 'shipped' as const, label: 'Shipped' },
                  ] as const
                ).map(({ mode, label }) => (
                  <button
                    key={mode}
                    type="button"
                    className={`filter-pill-btn${lifecycleFilter === mode ? ' active' : ''}`}
                    {...{ 'data-testid': `release-lifecycle-filter-${mode}` }}
                    onClick={() => setLifecycleFilter(mode)}
                  >
                    <span>{label}</span>
                    <span className="filter-pill-count">({lifecycleCounts[mode]})</span>
                  </button>
                ))}
              </div>

              <div className="toolbar-controls-right">
                <div className="toolbar-control-group">
                  <label htmlFor="release-group-by-select">Group By:</label>
                  <select
                    id="release-group-by-select"
                    className="toolbar-select"
                    {...{ 'data-testid': 'release-group-by' }}
                    value={releaseGroupBy}
                    onChange={(e) => {
                      const nextGroup = e.target.value as ReleaseGroupBy;
                      setReleaseGroupBy(nextGroup);
                      if (nextGroup === 'none') {
                        setSortColumn(null);
                      }
                    }}
                  >
                    <option value="none">Manual / Flat Order</option>
                    <option value="lifecycle">Lifecycle Stage</option>
                    {hasConfiguredPlatforms && (
                      <option value="platform">Target Platform</option>
                    )}
                  </select>
                </div>

                <input
                  type="search"
                  className="toolbar-search-input"
                  {...{ 'data-testid': 'release-search-input' }}
                  value={releaseSearchText}
                  onChange={(e) => setReleaseSearchText(e.target.value)}
                  placeholder="Search releases..."
                  aria-label="Search releases"
                />
              </div>
            </div>

            {hasConfiguredPlatforms && (
              <div className="toolbar-secondary-row">
                <div className="platform-filter-pills" role="group" aria-label="Filter releases by platform">
                  <button
                    type="button"
                    className={`filter-pill-btn${platformFilterSlug === null ? ' active' : ''}`}
                    {...{ 'data-testid': 'release-platform-filter-all' }}
                    onClick={() => setPlatformFilterSlug(null)}
                  >
                    All Platforms
                  </button>
                  {platforms.map((platform) => (
                    <button
                      key={platform.id}
                      type="button"
                      className={`filter-pill-btn${platformFilterSlug === platform.slug ? ' active' : ''}`}
                      {...{ 'data-testid': `release-platform-filter-${platform.slug}` }}
                      onClick={() =>
                        setPlatformFilterSlug(
                          platformFilterSlug === platform.slug ? null : platform.slug,
                        )
                      }
                    >
                      <span className={`platform-color-dot platform-dot-${platform.color}`} />
                      <span>{platform.name}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`filter-pill-btn${platformFilterSlug === 'unassigned' ? ' active' : ''}`}
                    {...{ 'data-testid': 'release-platform-filter-unassigned' }}
                    onClick={() =>
                      setPlatformFilterSlug(
                        platformFilterSlug === 'unassigned' ? null : 'unassigned',
                      )
                    }
                  >
                    Unassigned
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Release Epics Data Grid */}
      <div className="release-epics-grid">
        {loadingEpics ? (
          <div className="loading-message">Loading releases...</div>
        ) : releaseEpics.length === 0 ? (
          <div className="empty-message">No releases yet. Click &quot;+ New Release&quot; to create one.</div>
        ) : filteredEpics.length === 0 ? (
          <div className="empty-message" {...{ 'data-testid': 'release-filtered-empty' }}>
            No releases match the active filters.
          </div>
        ) : (
          <table className="epics-table">
            <thead>
              <tr>
                {canManageReleases && <th style={{width: '32px'}} title="Drag to reorder"></th>}
                <th style={{width: '40px'}}></th>
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-version' }} onClick={() => handleSort('version')}>
                  Version <span className="sort-indicator">{sortColumn === 'version' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                {hasConfiguredPlatforms && (
                  <th {...{ 'data-testid': 'release-col-platforms' }}>Platforms</th>
                )}
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-status' }} onClick={() => handleSort('status')}>
                  Status <span className="sort-indicator">{sortColumn === 'status' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-progress' }} onClick={() => handleSort('progress')}>
                  Progress <span className="sort-indicator">{sortColumn === 'progress' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-start-date' }} onClick={() => handleSort('startDate')}>
                  Start Date <span className="sort-indicator">{sortColumn === 'startDate' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-target-date' }} onClick={() => handleSort('targetDate')}>
                  Target Date <span className="sort-indicator">{sortColumn === 'targetDate' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                <th className="sortable-th" {...{ 'data-testid': 'release-sort-description' }} onClick={() => handleSort('description')}>
                  Description <span className="sort-indicator">{sortColumn === 'description' ? (sortDirection === 'asc' ? '↑' : '↓') : '↕'}</span>
                </th>
                <th>Result</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {releaseGroupBy === 'none'
                ? filteredEpics.map((epic, epicIndex) => renderReleaseEpicRow(epic, epicIndex))
                : groupedEpics.map((section) => {
                    const isSectionCollapsed = collapsedReleaseGroups.has(section.key);
                    return (
                      <React.Fragment key={`section-${section.key}`}>
                        <tr
                          className="release-group-header-row"
                          {...{ 'data-testid': `release-group-section-${section.key}` }}
                        >
                          <td colSpan={columnCount}>
                            <button
                              type="button"
                              className="release-group-header-btn"
                              {...{ 'data-testid': `release-group-toggle-${section.key}` }}
                              onClick={() => toggleReleaseGroupCollapse(section.key)}
                            >
                              <span className="release-group-header-left">
                                <span>{isSectionCollapsed ? '▶' : '▼'}</span>
                                {section.color && (
                                  <span
                                    className={`platform-color-dot platform-dot-${section.color}`}
                                  />
                                )}
                                <span>{section.label}</span>
                                <span>
                                  ({section.releaseCount} release
                                  {section.releaseCount === 1 ? '' : 's'})
                                </span>
                              </span>
                              <span className="release-group-header-right">
                                <span>{section.completionPercent}% validated</span>
                                <span>{section.leftToValidate} left to validate</span>
                              </span>
                            </button>
                          </td>
                        </tr>
                        {!isSectionCollapsed &&
                          section.epics.map((epic, idx) => renderReleaseEpicRow(epic, idx))}
                      </React.Fragment>
                    );
                  })}
            </tbody>
          </table>
        )}
      </div>

      {selectedRelease && !loading && (
        <>
          {/* Metrics Dashboard */}
          <div className="release-metrics">
            <div className="metric-card">
              <div className="metric-label">Total Features</div>
              <div className="metric-value">{releaseMetrics?.totalFeatures || 0}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Completed</div>
              <div className="metric-value completed">{releaseMetrics?.completedFeatures || 0}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">In Progress</div>
              <div className="metric-value in-progress">{releaseMetrics?.inProgressFeatures || 0}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Blocked</div>
              <div className="metric-value blocked">{releaseMetrics?.blockedFeatures || 0}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Ready for Release</div>
              <div className="metric-value ready">{releaseMetrics?.readyForReleaseFeatures || 0}</div>
            </div>
            <div className={`metric-card health-${healthStatus}`}>
              <div className="metric-label">Health</div>
              <div className="metric-value">{healthStatus.replace('-', ' ')}</div>
            </div>
          </div>

          {/* Progress Bar */}
          <div className="release-progress">
            <div className="progress-header">
              <span>Completion: {completionPercentage}%</span>
              <div className="progress-legend">
                <span className="legend-item"><span className="legend-dot legend-green"></span>Ready / Done</span>
                <span className="legend-item"><span className="legend-dot legend-amber"></span>UAT Ready for Test</span>
                <span className="legend-item"><span className="legend-dot legend-red"></span>Other</span>
              </div>
            </div>
            <div className="progress-bar">
              {releaseMetrics && releaseMetrics.totalFeatures > 0 && (
                <>
                  <div 
                    className="progress-segment segment-green" 
                    style={{ width: `${(releaseMetrics.completedFeatures / releaseMetrics.totalFeatures) * 100}%` }}
                    title={`Ready / Done: ${releaseMetrics.completedFeatures}`}
                  ></div>
                  <div 
                    className="progress-segment segment-amber" 
                    style={{ width: `${((releaseMetrics.uatReadyForTestFeatures || 0) / releaseMetrics.totalFeatures) * 100}%` }}
                    title={`UAT Ready for Test: ${releaseMetrics.uatReadyForTestFeatures || 0}`}
                  ></div>
                  <div 
                    className="progress-segment segment-red" 
                    style={{ width: `${((releaseMetrics.totalFeatures - releaseMetrics.completedFeatures - (releaseMetrics.uatReadyForTestFeatures || 0)) / releaseMetrics.totalFeatures) * 100}%` }}
                    title={`Other: ${releaseMetrics.totalFeatures - releaseMetrics.completedFeatures - (releaseMetrics.uatReadyForTestFeatures || 0)}`}
                  ></div>
                </>
              )}
            </div>
          </div>

          {/* Release Notes */}
          <div className="release-notes-section">
            <h3>Release Notes</h3>
            <div className="release-notes-actions">
              <button {...{ 'data-testid': 'release-notes-markdown' }} onClick={() => downloadReleaseNotes('markdown')}>
                Download Markdown
              </button>
              <button {...{ 'data-testid': 'release-notes-json' }} onClick={() => downloadReleaseNotes('json')}>
                Download JSON
              </button>
            </div>
          </div>

          {/* Work Items List */}
          <div className="release-work-items">
            <h3>Features & Epics ({releaseWorkItems.length})</h3>
            <div className="work-items-table">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Title</th>
                    <th>State</th>
                    <th>Assigned To</th>
                    <th>Target Date</th>
                  </tr>
                </thead>
                <tbody>
                  {releaseWorkItems.map((wi) => (
                    <tr 
                      key={wi.id}
                      {...{ 'data-testid': `release-work-item-${wi.id}` }}
                      onClick={() => onSelectItem && onSelectItem(wi)}
                      className="clickable-row"
                    >
                      <td>{wi.id}</td>
                      <td>{wi.workItemType}</td>
                      <td>{wi.title}</td>
                      <td>
                        <span className={`state-badge ${getStateClass(wi.state)}`}>
                          {wi.state}
                        </span>
                      </td>
                      <td>{wi.assignedTo || 'Unassigned'}</td>
                      <td>{formatDate(wi.targetDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {loading && (
        <div className="loading-message">Loading release details...</div>
      )}
      </>
      )}

      {/* New/Edit Release Modal */}
      {showNewReleaseModal && (
        <div className="modal-overlay" {...{ 'data-testid': 'release-form-overlay' }} onClick={handleCloseModal}>
          <div className="modal-content" {...{ 'data-testid': 'release-form-modal' }} onClick={(e) => e.stopPropagation()}>
            <h3>{isEditMode ? 'Edit Release' : 'Create New Release'}</h3>
            {isEditMode && (
              <div className="form-group">
                <label>Status:</label>
                <select
                  {...{ 'data-testid': 'release-form-status' }}
                  value={newReleaseStatus}
                  onChange={(e) => setNewReleaseStatus(e.target.value)}
                  className="status-select"
                >
                  <option value="New">New</option>
                  <option value="In Progress">In Progress</option>
                  <option value="In Design">In Design</option>
                  <option value="Done">Done</option>
                  <option value="Removed">Removed</option>
                </select>
              </div>
            )}
            <div className="form-group">
              <label>Release Name: <span style={{color: 'red'}}>*</span></label>
              <input
                type="text"
                {...{ 'data-testid': 'release-form-name' }}
                value={newReleaseVersion}
                onChange={(e) => setNewReleaseVersion(e.target.value)}
                placeholder="e.g., v1.0.0, 2024-Q1"
                required
                disabled={isEditMode}
              />
            </div>
            <div className="form-group">
              <label>Start Date: <span style={{color: 'red'}}>*</span></label>
              <input
                type="date"
                {...{ 'data-testid': 'release-form-start-date' }}
                value={newReleaseStartDate}
                onChange={(e) => setNewReleaseStartDate(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Target Date: <span style={{color: 'red'}}>*</span></label>
              <input
                type="date"
                {...{ 'data-testid': 'release-form-target-date' }}
                value={newReleaseTargetDate}
                onChange={(e) => setNewReleaseTargetDate(e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>Description: <span style={{color: 'red'}}>*</span></label>
              <textarea
                {...{ 'data-testid': 'release-form-description' }}
                value={newReleaseDescription}
                onChange={(e) => setNewReleaseDescription(e.target.value)}
                placeholder="Release description..."
                rows={4}
                required
              />
            </div>
            <div className="modal-actions">
              <button
                {...{ 'data-testid': 'release-form-save' }}
                onClick={isEditMode ? handleUpdateRelease : handleCreateRelease} 
                className="btn-primary"
                disabled={!newReleaseVersion || !newReleaseStartDate || !newReleaseTargetDate || !newReleaseDescription}
              >
                {isEditMode ? 'Update Release' : 'Create Release'}
              </button>
              <button {...{ 'data-testid': 'release-form-cancel' }} onClick={handleCloseModal} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Link Items Modal */}
      {showLinkItemsModal && (
        <div className="modal-overlay" {...{ 'data-testid': 'release-link-overlay' }} onClick={handleCloseLinkItemsModal}>
          <div className="modal-content modal-large" {...{ 'data-testid': 'release-link-modal' }} onClick={(e) => e.stopPropagation()}>
            <h3>Link Items to Release</h3>
            
            <div className="search-section">
              <div className="search-filters">
                <div className="form-group">
                  <label>Search:</label>
                  <input
                    type="text"
                    {...{ 'data-testid': 'release-link-search' }}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by ID, title, or keyword..."
                    className="search-input"
                  />
                </div>
                <div className="form-group">
                  <label>Type:</label>
                  <select
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
                        className="btn-select-all"
                        {...{ 'data-testid': 'release-link-select-all' }}
                        onClick={() => {
                          if (selectedItemsToLink.length === searchResults.length) {
                            setSelectedItemsToLink([]);
                          } else {
                            setSelectedItemsToLink(searchResults.map(wi => wi.id));
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
                              setSelectedItemsToLink(selectedItemsToLink.filter(id => id !== item.id));
                            }
                          }}
                        />
                        <div className="result-item-details">
                          <div className="result-item-header">
                            <span className="result-item-id">#{item.id}</span>
                            <span className="result-item-type">{item.workItemType}</span>
                            <span className={`result-item-state state-${item.state.toLowerCase().replace(/\s+/g, '-')}`}>
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
                {...{ 'data-testid': 'release-link-submit' }}
                onClick={handleLinkItems} 
                className="btn-primary"
                disabled={selectedItemsToLink.length === 0}
              >
                Link {selectedItemsToLink.length} Item{selectedItemsToLink.length !== 1 ? 's' : ''}
              </button>
              <button {...{ 'data-testid': 'release-link-cancel' }} onClick={handleCloseLinkItemsModal} className="btn-secondary">
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
        <div className="modal-overlay" {...{ 'data-testid': 'release-delete-overlay' }} onClick={() => !isDeleting && setShowDeleteConfirmModal(false)}>
          <div className="modal-content" {...{ 'data-testid': 'release-delete-modal' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Confirm Delete Release Epic</h3>
              <button className="modal-close" {...{ 'data-testid': 'release-delete-close' }} onClick={() => setShowDeleteConfirmModal(false)} disabled={isDeleting}>✕</button>
            </div>
            <div className="modal-body">
              <div className="modal-icon-danger">🗑️</div>
              <p className="modal-message">
                Are you sure you want to delete this release epic?
              </p>
              <div className="modal-epic-info-delete">
                <span className="modal-epic-version">
                  {releaseEpics.find(e => e.id === deletingEpicId)?.version}
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
                className="modal-btn modal-btn-cancel"
                {...{ 'data-testid': 'release-delete-cancel' }}
                onClick={() => setShowDeleteConfirmModal(false)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="modal-btn modal-btn-danger"
                {...{ 'data-testid': 'release-delete-confirm' }}
                onClick={handleDeleteReleaseEpic}
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
            sortedEpics.map((epic) => epic.version as string),
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

      {showPlatformsModal && (
        // data-testid-exempt — ReleasePlatformModal renders data-testid="release-platforms-modal" internally
        <ReleasePlatformModal
          project={project}
          platforms={platforms}
          isBusy={
            createPlatform.isPending ||
            reorderPlatforms.isPending ||
            deletePlatform.isPending
          }
          onClose={() => setShowPlatformsModal(false)}
          onCreatePlatform={({ name, color }) =>
            createPlatform.mutateAsync({ name, color })
          }
          onReorderPlatforms={(platformIds) =>
            reorderPlatforms.mutateAsync(platformIds)
          }
          onDeletePlatform={(platformId) =>
            deletePlatform.mutateAsync(platformId)
          }
        />
      )}
    </div>
  );
};

export default ReleaseView;
