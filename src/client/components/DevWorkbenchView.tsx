import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useActiveSessions,
  useAssignedWorkItems,
  useCloseDevSession,
  useCompleteFeature,
  useStartDevSession,
  useStartLocalFeature,
} from '../hooks/useDevWorkbench';
import { useApexBacklogFeatures } from '../hooks/useApexBacklog';
import type { BacklogFeatureItem, ActiveDevSession, ApexBacklogGroup } from '../../shared/types/devWorkbench';
import {
  evaluateDevStartEligibility,
  isAppNativeRequirementsProject,
} from '../../shared/types/devWorkbench';
import {
  computeFeatureWorkStatus,
  formatMyWorkStatusLabel,
  rollupWorkStatus,
  type MyWorkStatus,
} from '../../shared/utils/myWorkStatus';
import StartLocalDevModal, { type StartLocalDevTarget } from './StartLocalDevModal';
import FeatureContextModal from './FeatureContextModal';
import styles from './DevWorkbenchView.module.css';

export type ApexStatusFilter = 'all' | MyWorkStatus;

export const APEX_STATUS_FILTERS: { id: ApexStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'complete', label: 'Complete' },
];

/** Keep a PRD/Epic group when filtering by feature status. */
export function filterApexBacklogByStatus(
  groups: ApexBacklogGroup[],
  sessions: ActiveDevSession[],
  filter: ApexStatusFilter,
  /** Feature keys (`prdId:featureId`) treated as Complete before sessions refetch. */
  locallyCompleted: ReadonlySet<string> = new Set(),
): ApexBacklogGroup[] {
  if (filter === 'all' && locallyCompleted.size === 0) return groups;

  return groups
    .map((group) => {
      const epics = group.epics
        .map((epic) => {
          const features = epic.features.filter((feature) => {
            const key = `${feature.prdId}:${feature.featureId}`;
            const readiness = computeFeatureWorkStatus(feature, sessions, sessions);
            const state: MyWorkStatus =
              readiness.state === 'complete' || locallyCompleted.has(key)
                ? 'complete'
                : readiness.state;
            return filter === 'all' || state === filter;
          });
          return { ...epic, features };
        })
        .filter((epic) => epic.features.length > 0);
      return { ...group, epics };
    })
    .filter((group) => group.epics.length > 0);
}

/**
 * Filter Apex backlog by a case-insensitive title query against PRD, Epic,
 * and Feature titles (also matches feature ids like FEAT-001).
 *
 * - PRD title match → keep all epics/features under that PRD
 * - Epic title match → keep all features under that epic
 * - Otherwise → keep only features whose title or id matches
 */
export function filterApexBacklogBySearch(
  groups: ApexBacklogGroup[],
  searchQuery: string,
): ApexBacklogGroup[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return groups;

  return groups
    .map((group) => {
      const prdMatches = group.prdTitle.toLowerCase().includes(q);
      const epics = group.epics
        .map((epic) => {
          const epicMatches = epic.epicTitle.toLowerCase().includes(q);
          const features =
            prdMatches || epicMatches
              ? epic.features
              : epic.features.filter(
                  (feature) =>
                    feature.featureTitle.toLowerCase().includes(q) ||
                    feature.featureId.toLowerCase().includes(q),
                );
          return { ...epic, features };
        })
        .filter((epic) => epic.features.length > 0);
      return { ...group, epics };
    })
    .filter((group) => group.epics.length > 0);
}

function featureCompleteKey(prdId: string, featureId: string): string {
  return `${prdId}:${featureId}`;
}

function formatStatusAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusBadgeClass(state: MyWorkStatus): string {
  switch (state) {
    case 'ready':
      return styles['ready-badge'];
    case 'in_progress':
      return styles['active-badge'];
    case 'complete':
      return styles['completed-badge'];
  }
}

const WorkStatusBadge: React.FC<{
  state: MyWorkStatus;
  statusAt: string | null;
  'data-testid'?: string;
}> = ({ state, statusAt, 'data-testid': testId }) => {
  const formatted = formatStatusAt(statusAt);
  return (
    <span
      className={styles['status-with-time']}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className={statusBadgeClass(state)}>{formatMyWorkStatusLabel(state)}</span>
      {formatted && <span className={styles['status-timestamp']}>{formatted}</span>}
    </span>
  );
};

const ApexBacklogView: React.FC<{
  project: string;
  activeSessions: ActiveDevSession[];
}> = ({ project, activeSessions }) => {
  const { data: backlogGroups, isLoading, error } = useApexBacklogFeatures(project);
  const closeSession = useCloseDevSession();
  const completeFeature = useCompleteFeature();
  const startLocalFeature = useStartLocalFeature();
  const [closingId, setClosingId] = useState<string | null>(null);
  const [completingFeature, setCompletingFeature] = useState<string | null>(null);
  const [openPrds, setOpenPrds] = useState<Set<string>>(() => new Set());
  const [openEpics, setOpenEpics] = useState<Set<string>>(() => new Set());
  const [localDevTarget, setLocalDevTarget] = useState<StartLocalDevTarget | null>(null);
  const [selectedContextFeature, setSelectedContextFeature] = useState<BacklogFeatureItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<ApexStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [locallyCompleted, setLocallyCompleted] = useState<Set<string>>(() => new Set());

  const allSessions = useMemo(() => activeSessions ?? [], [activeSessions]);

  const filteredGroups = useMemo(() => {
    const byStatus = filterApexBacklogByStatus(
      backlogGroups ?? [],
      allSessions,
      statusFilter,
      locallyCompleted,
    );
    return filterApexBacklogBySearch(byStatus, searchQuery);
  }, [backlogGroups, allSessions, statusFilter, locallyCompleted, searchQuery]);

  // Expand matching PRDs/Epics while searching so hits are visible.
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const prdKeys = new Set(filteredGroups.map((g) => g.prdId));
    const epicKeys = new Set<string>();
    filteredGroups.forEach((g) => g.epics.forEach((_e, i) => epicKeys.add(`${g.prdId}-${i}`)));
    setOpenPrds(prdKeys);
    setOpenEpics(epicKeys);
  }, [searchQuery, filteredGroups]);

  const togglePrd = (prdId: string) => {
    setOpenPrds(prev => {
      const next = new Set(prev);
      if (next.has(prdId)) next.delete(prdId); else next.add(prdId);
      return next;
    });
  };

  const toggleEpic = (key: string) => {
    setOpenEpics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleClearProgress = async (sessionId: string) => {
    setClosingId(sessionId);
    try {
      await closeSession.mutateAsync(sessionId);
    } finally {
      setClosingId(null);
    }
  };

  const handleComplete = async (feature: BacklogFeatureItem) => {
    setCompletingFeature(feature.featureId);
    try {
      await completeFeature.mutateAsync({ prdId: feature.prdId, featureId: feature.featureId, project });
      setLocallyCompleted(prev => {
        const next = new Set(prev);
        next.add(featureCompleteKey(feature.prdId, feature.featureId));
        return next;
      });
    } finally {
      setCompletingFeature(null);
    }
  };

  const handleStartLocal = async (feature: BacklogFeatureItem) => {
    try {
      await startLocalFeature.mutateAsync({
        prdId: feature.prdId,
        featureId: feature.featureId,
        project,
      });
    } catch {
      // Still open the modal so the user can download the pack even if status
      // persistence fails; the badge will refresh on the next sessions poll.
    }
    setLocalDevTarget({
      kind: 'apex',
      project,
      prdId: feature.prdId,
      featureId: feature.featureId,
      title: feature.featureTitle,
    });
  };

  if (isLoading) {
    return <div className={styles.loading}>Loading Apex backlog features...</div>;
  }

  if (error) {
    return <div className={styles.error}>Failed to load backlog: {error.message}</div>;
  }

  if (!backlogGroups || backlogGroups.length === 0) {
    return (
      <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
        No approved PRDs with backlog features found for Apex.
      </div>
    );
  }

  return (
    <div className={styles['apex-backlog']} {...{ 'data-testid': 'my-work-apex-backlog' }}>
      {startLocalFeature.error && (
        <div className={styles.error}>{startLocalFeature.error.message}</div>
      )}

      <div className={styles['filters-row']}>
        <div
          className={styles.filters}
          role="toolbar"
          aria-label="Filter features by status"
          {...{ 'data-testid': 'my-work-status-filters' }}
        >
          {APEX_STATUS_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`${styles['filter-pill']}${statusFilter === id ? ` ${styles['filter-pill-active']}` : ''}`}
              aria-pressed={statusFilter === id}
              onClick={() => setStatusFilter(id)}
              {...{ 'data-testid': `my-work-status-filter-${id}` }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles['search-wrap']}>
          <svg
            className={styles['search-icon']}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10" y1="10" x2="14" y2="14" />
          </svg>
          <input
            className={styles['search-input']}
            type="search"
            placeholder="Search PRDs, epics, features…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search PRDs, epics, and features"
            {...{ 'data-testid': 'my-work-search-input' }}
          />
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
          {searchQuery.trim()
            ? 'No PRDs, epics, or features match this search.'
            : 'No features match this filter.'}
        </div>
      ) : (
        filteredGroups.map(group => {
          const featureStatuses = group.epics.flatMap(epic =>
            epic.features.map(feature => {
              const key = featureCompleteKey(feature.prdId, feature.featureId);
              const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
              if (readiness.state === 'complete' || locallyCompleted.has(key)) {
                return {
                  ...readiness,
                  state: 'complete' as const,
                  statusAt: readiness.statusAt ?? new Date().toISOString(),
                };
              }
              return readiness;
            }),
          );
          const prdStatus = rollupWorkStatus(featureStatuses);

          return (
            <div key={group.prdId} className={styles['prd-group']}>
              <button
                className={styles['prd-header']}
                onClick={() => togglePrd(group.prdId)}
                type="button"
                aria-expanded={openPrds.has(group.prdId)}
                {...{ 'data-testid': `my-work-prd-toggle-${group.prdId}` }}
              >
                <span className={styles['toggle-icon']}>{openPrds.has(group.prdId) ? '▼' : '▶'}</span>
                <span className={styles['prd-label']}>PRD:</span>
                <span className={styles['prd-title']}>{group.prdTitle}</span>
                <WorkStatusBadge
                  state={prdStatus.state}
                  statusAt={prdStatus.statusAt}
                  {...{ 'data-testid': `my-work-prd-status-${group.prdId}` }}
                />
              </button>

              {openPrds.has(group.prdId) && group.epics.map((epic, epicIdx) => {
                const epicKey = `${group.prdId}-${epicIdx}`;
                const epicFeatureStatuses = epic.features.map(feature => {
                  const key = featureCompleteKey(feature.prdId, feature.featureId);
                  const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
                  if (readiness.state === 'complete' || locallyCompleted.has(key)) {
                    return {
                      ...readiness,
                      state: 'complete' as const,
                      statusAt: readiness.statusAt ?? new Date().toISOString(),
                    };
                  }
                  return readiness;
                });
                const epicStatus = rollupWorkStatus(epicFeatureStatuses);

                return (
                  <div key={epicKey} className={styles['epic-group']}>
                    <button
                      className={styles['epic-header']}
                      onClick={() => toggleEpic(epicKey)}
                      type="button"
                      aria-expanded={openEpics.has(epicKey)}
                      {...{ 'data-testid': `my-work-epic-toggle-${epicKey}` }}
                    >
                      <span className={styles['toggle-icon']}>{openEpics.has(epicKey) ? '▼' : '▶'}</span>
                      <span className={styles['epic-label']}>Epic:</span>
                      <span className={styles['epic-title']}>{epic.epicTitle}</span>
                      <WorkStatusBadge
                        state={epicStatus.state}
                        statusAt={epicStatus.statusAt}
                        {...{ 'data-testid': `my-work-epic-status-${epicKey}` }}
                      />
                    </button>

                    {openEpics.has(epicKey) && (
                      <div className={styles['feature-list']} {...{ 'data-testid': 'my-work-feature-list' }}>
                        {epic.features.map(feature => {
                          const key = featureCompleteKey(feature.prdId, feature.featureId);
                          const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
                          const isComplete =
                            readiness.state === 'complete' || locallyCompleted.has(key);
                          const isInProgress = !isComplete && readiness.state === 'in_progress';
                          const isBlocked = !!readiness.blockedBy;

                          return (
                            <div key={feature.featureId} className={styles['feature-item']}>
                              <div className={styles['feature-info']}>
                                <div className={styles['feature-title-row']}>
                                  <span className={styles['feature-id']}>{feature.featureId}</span>
                                  <span className={styles['feature-title']}>{feature.featureTitle}</span>
                                </div>
                                <div className={styles['feature-meta']}>
                                  <span className={styles.badge}>{feature.featurePriority}</span>
                                  <span className={styles['item-count']}>{feature.pbiCount} PBIs, {feature.tbiCount} TBIs</span>
                                  {feature.designDocStatus && (
                                    <span className={styles.badge}>Design: {feature.designDocStatus}</span>
                                  )}
                                  <WorkStatusBadge
                                    state={isComplete ? 'complete' : readiness.state}
                                    statusAt={
                                      isComplete
                                        ? (readiness.statusAt ?? new Date().toISOString())
                                        : readiness.statusAt
                                    }
                                    {...{ 'data-testid': `my-work-feature-status-${feature.featureId}` }}
                                  />
                                  {isBlocked && !isComplete && (
                                    <span className={styles['blocked-badge']}>Blocked by {readiness.blockedBy}</span>
                                  )}
                                  {readiness.hasPr && !isComplete && (
                                    <span className={styles['active-badge']}>In PR</span>
                                  )}
                                </div>
                              </div>
                              <div className={styles['item-actions']}>
                                <button
                                  className={styles['view-context-btn']}
                                  onClick={() => setSelectedContextFeature(feature)}
                                  type="button"
                                  title="Inspect PRD, backlog, design artifacts, and prototype"
                                  {...{ 'data-testid': 'my-work-view-context-btn' }}
                                >
                                  View Context
                                </button>
                                {isComplete ? (
                                  <span className={styles['completed-label']}>Done</span>
                                ) : (
                                  <>
                                    {isInProgress && readiness.sessionId && (
                                      <button
                                        className={styles['close-btn']}
                                        onClick={() => handleClearProgress(readiness.sessionId!)}
                                        disabled={closingId === readiness.sessionId}
                                        type="button"
                                        title="Clear in-progress status for this feature"
                                        {...{ 'data-testid': `my-work-clear-progress-${feature.featureId}` }}
                                      >
                                        {closingId === readiness.sessionId ? 'Closing...' : 'Clear Progress'}
                                      </button>
                                    )}
                                    <button
                                      className={styles['complete-btn']}
                                      onClick={() => handleComplete(feature)}
                                      disabled={completingFeature !== null}
                                      type="button"
                                      title="Mark this feature as complete to unblock dependent features"
                                      {...{ 'data-testid': 'my-work-mark-complete-btn' }}
                                    >
                                      {completingFeature === feature.featureId ? 'Completing...' : 'Mark Complete'}
                                    </button>
                                    <button
                                      className={styles['local-dev-btn']}
                                      onClick={() => handleStartLocal(feature)}
                                      disabled={startLocalFeature.isPending}
                                      type="button"
                                      title="Mark In Progress, download a context pack, and open Cursor or VS Code locally"
                                      {...{ 'data-testid': 'my-work-start-local-dev-btn' }}
                                    >
                                      Start Local Development
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}

      {localDevTarget && (
        // data-testid-exempt — StartLocalDevModal root already sets data-testid
        <StartLocalDevModal
          target={localDevTarget}
          onClose={() => setLocalDevTarget(null)}
        />
      )}

      {selectedContextFeature && (
        // data-testid-exempt — FeatureContextModal root already sets data-testid
        <FeatureContextModal
          project={project}
          feature={selectedContextFeature}
          onClose={() => setSelectedContextFeature(null)}
        />
      )}
    </div>
  );
};

export const DevWorkbenchView: React.FC = () => {
  const navigate = useNavigate();
  const { selectedProject, isSuperAdmin } = useAppShell();
  const usesAppNativeRequirements = isAppNativeRequirementsProject(selectedProject);

  const { data: workItems, isLoading, error } = useAssignedWorkItems(
    usesAppNativeRequirements ? null : (selectedProject || null),
  );
  const { data: activeSessions } = useActiveSessions(selectedProject || null);
  const startSession = useStartDevSession();
  const closeSession = useCloseDevSession();
  const [startingId, setStartingId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [localDevTarget, setLocalDevTarget] = useState<StartLocalDevTarget | null>(null);

  const sessionByWorkItem = useMemo(() => {
    const map = new Map<number, { sessionId: string }>();
    if (activeSessions) {
      for (const s of activeSessions) {
        if (s.status !== 'closed' && s.status !== 'failed' && s.workItemId) {
          map.set(s.workItemId, { sessionId: s.id });
        }
      }
    }
    return map;
  }, [activeSessions]);

  const sortedWorkItems = useMemo(() => {
    if (!workItems) return [];
    return [...workItems].sort((a, b) => {
      const aActive = sessionByWorkItem.has(a.id) ? 0 : 1;
      const bActive = sessionByWorkItem.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
  }, [workItems, sessionByWorkItem]);

  const handleStart = async (workItemId: number) => {
    if (!selectedProject) return;
    setStartingId(workItemId);
    try {
      const result = await startSession.mutateAsync({ workItemId, project: selectedProject });
      navigate(`/my-work/session/${result.sessionId}`);
    } finally {
      setStartingId(null);
    }
  };

  const handleResume = (sessionId: string) => {
    navigate(`/my-work/session/${sessionId}`);
  };

  const handleClose = async (sessionId: string) => {
    setClosingId(sessionId);
    try {
      await closeSession.mutateAsync(sessionId);
    } finally {
      setClosingId(null);
    }
  };

  if (usesAppNativeRequirements && selectedProject) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.header} {...{ 'data-testid': 'my-work-header' }}>
          <h1 className={styles.title}>My Work</h1>
          <p className={styles.subtitle}>Approved PRD features ready for development</p>
        </div>
        <section
          className={styles.section}
          aria-labelledby="feature-backlog-heading"
          {...{ 'data-testid': 'my-work-feature-backlog-section' }}
        >
          <div className={styles['section-header']}>
            <h2 id="feature-backlog-heading">Feature Backlog</h2>
            <p>Approved PRD features</p>
          </div>
          <ApexBacklogView project={selectedProject} activeSessions={activeSessions ?? []} />
        </section>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.loading}>Loading assigned work items...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.error}>Failed to load work items: {error.message}</div>
      </div>
    );
  }

  return (
    <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
      <div className={styles.header} {...{ 'data-testid': 'my-work-header' }}>
        <h1 className={styles.title}>My Work</h1>
        <p className={styles.subtitle}>Work items assigned to you — start a development session to begin coding</p>
      </div>

      {startSession.error && (
        <div className={styles.error}>{startSession.error.message}</div>
      )}

      {!workItems || workItems.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
          No active work items assigned to you.
        </div>
      ) : (
        <div className={styles.list} {...{ 'data-testid': 'my-work-work-items-list' }}>
          {sortedWorkItems.map((item) => {
            const active = sessionByWorkItem.get(item.id);
            const eligibility = evaluateDevStartEligibility(item, { isSuperAdmin });
            return (
              <div key={item.id} className={styles.item}>
                <div className={styles['item-info']}>
                  <span className={styles['item-title']}>{item.title}</span>
                  <div className={styles['item-meta']}>
                    <span className={styles['item-id']}>#{item.id}</span>
                    <span className={styles.badge}>{item.workItemType}</span>
                    <span className={styles.badge}>{item.state}</span>
                    {active && <span className={styles['active-badge']}>Active Session</span>}
                  </div>
                </div>
                <div className={styles['item-actions']}>
                  {active ? (
                    <>
                      <button
                        className={styles['resume-btn']}
                        onClick={() => handleResume(active.sessionId)}
                        type="button"
                        {...{ 'data-testid': 'my-work-resume-session-btn' }}
                      >
                        Resume Session
                      </button>
                      <button
                        className={styles['close-btn']}
                        onClick={() => handleClose(active.sessionId)}
                        disabled={closingId === active.sessionId}
                        type="button"
                        {...{ 'data-testid': `my-work-close-session-${item.id}` }}
                      >
                        {closingId === active.sessionId ? 'Closing...' : 'Close Session'}
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles['start-btn']}
                      onClick={() => handleStart(item.id)}
                      disabled={startingId !== null || !eligibility.allowed}
                      title={eligibility.allowed ? undefined : eligibility.reason}
                      type="button"
                      {...{ 'data-testid': 'my-work-start-dev-btn' }}
                    >
                      {startingId === item.id ? 'Starting...' : 'Start Development'}
                    </button>
                  )}
                  <button
                    className={styles['local-dev-btn']}
                    onClick={() =>
                      setLocalDevTarget({
                        kind: 'ado',
                        project: selectedProject!,
                        workItemId: item.id,
                        title: item.title,
                      })
                    }
                    type="button"
                    title="Download a context pack and open Cursor or VS Code locally"
                    {...{ 'data-testid': 'my-work-start-local-dev-btn' }}
                  >
                    Start Local Development
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {localDevTarget && (
        // data-testid-exempt — StartLocalDevModal root already sets data-testid
        <StartLocalDevModal
          target={localDevTarget}
          onClose={() => setLocalDevTarget(null)}
        />
      )}
    </div>
  );
};
