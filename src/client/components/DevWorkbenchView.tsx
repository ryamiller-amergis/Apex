import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useAssignedWorkItems, useStartDevSession, useActiveSessions, useCloseDevSession } from '../hooks/useDevWorkbench';
import { useApexBacklogFeatures } from '../hooks/useApexBacklog';
import type { BacklogFeatureItem, ActiveDevSession } from '../../shared/types/devWorkbench';
import styles from './DevWorkbenchView.module.css';

interface FeatureReadiness {
  state: 'ready' | 'blocked' | 'in_progress' | 'in_pr' | 'closed';
  blockedBy?: string;
  sessionId?: string;
}

function computeReadiness(
  feature: BacklogFeatureItem,
  sessions: ActiveDevSession[],
  allSessions: ActiveDevSession[],
): FeatureReadiness {
  const featureSession = sessions.find(s => s.featureId === feature.featureId && s.prdId === feature.prdId);
  if (featureSession) {
    if (featureSession.prUrl) return { state: 'in_pr', sessionId: featureSession.id };
    if (featureSession.status === 'closed') return { state: 'closed', sessionId: featureSession.id };
    return { state: 'in_progress', sessionId: featureSession.id };
  }

  if (feature.dependsOn.length > 0) {
    for (const dep of feature.dependsOn) {
      const depSession = allSessions.find(s => s.featureId === dep && s.status === 'closed');
      if (!depSession) {
        return { state: 'blocked', blockedBy: dep };
      }
    }
  }

  return { state: 'ready' };
}

const ApexBacklogView: React.FC<{
  project: string;
  activeSessions: ActiveDevSession[];
}> = ({ project, activeSessions }) => {
  const navigate = useNavigate();
  const { data: backlogGroups, isLoading, error } = useApexBacklogFeatures(project);
  const startSession = useStartDevSession();
  const closeSession = useCloseDevSession();
  const [startingFeature, setStartingFeature] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [openPrds, setOpenPrds] = useState<Set<string>>(new Set());
  const [openEpics, setOpenEpics] = useState<Set<string>>(new Set());

  const allSessions = activeSessions ?? [];

  // Default all open on first load
  useMemo(() => {
    if (backlogGroups && openPrds.size === 0) {
      const prdKeys = new Set(backlogGroups.map(g => g.prdId));
      setOpenPrds(prdKeys);
      const epicKeys = new Set<string>();
      backlogGroups.forEach(g => g.epics.forEach((_e, i) => epicKeys.add(`${g.prdId}-${i}`)));
      setOpenEpics(epicKeys);
    }
  }, [backlogGroups]);

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

  const handleStart = async (feature: BacklogFeatureItem) => {
    setStartingFeature(feature.featureId);
    try {
      const result = await startSession.mutateAsync({ prdId: feature.prdId, featureId: feature.featureId, project });
      navigate(`/my-work/session/${result.sessionId}`);
    } finally {
      setStartingFeature(null);
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

  if (isLoading) {
    return <div className={styles.loading}>Loading Apex backlog features...</div>;
  }

  if (error) {
    return <div className={styles.error}>Failed to load backlog: {error.message}</div>;
  }

  if (!backlogGroups || backlogGroups.length === 0) {
    return <div className={styles.empty}>No approved PRDs with backlog features found for Apex.</div>;
  }

  return (
    <div className={styles['apex-backlog']}>
      {startSession.error && (
        <div className={styles.error}>{startSession.error.message}</div>
      )}

      {backlogGroups.map(group => (
        <div key={group.prdId} className={styles['prd-group']}>
          <button
            className={styles['prd-header']}
            onClick={() => togglePrd(group.prdId)}
            type="button"
          >
            <span className={styles['toggle-icon']}>{openPrds.has(group.prdId) ? '▼' : '▶'}</span>
            <span className={styles['prd-label']}>PRD:</span>
            <span className={styles['prd-title']}>{group.prdTitle}</span>
          </button>

          {openPrds.has(group.prdId) && group.epics.map((epic, epicIdx) => {
            const epicKey = `${group.prdId}-${epicIdx}`;
            return (
              <div key={epicKey} className={styles['epic-group']}>
                <button
                  className={styles['epic-header']}
                  onClick={() => toggleEpic(epicKey)}
                  type="button"
                >
                  <span className={styles['toggle-icon']}>{openEpics.has(epicKey) ? '▼' : '▶'}</span>
                  <span className={styles['epic-label']}>Epic:</span>
                  <span className={styles['epic-title']}>{epic.epicTitle}</span>
                </button>

                {openEpics.has(epicKey) && (
                  <div className={styles['feature-list']}>
                    {epic.features.map(feature => {
                      const readiness = computeReadiness(feature, allSessions, allSessions);
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
                              {readiness.state === 'blocked' && (
                                <span className={styles['blocked-badge']}>Blocked by {readiness.blockedBy}</span>
                              )}
                              {readiness.state === 'in_progress' && (
                                <span className={styles['active-badge']}>In Progress</span>
                              )}
                              {readiness.state === 'in_pr' && (
                                <span className={styles['active-badge']}>In PR</span>
                              )}
                              {readiness.state === 'ready' && (
                                <span className={styles['ready-badge']}>Ready</span>
                              )}
                            </div>
                          </div>
                          <div className={styles['item-actions']}>
                            {readiness.state === 'in_progress' || readiness.state === 'in_pr' ? (
                              <>
                                <button
                                  className={styles['resume-btn']}
                                  onClick={() => handleResume(readiness.sessionId!)}
                                  type="button"
                                >
                                  Resume Session
                                </button>
                                <button
                                  className={styles['close-btn']}
                                  onClick={() => handleClose(readiness.sessionId!)}
                                  disabled={closingId === readiness.sessionId}
                                  type="button"
                                >
                                  {closingId === readiness.sessionId ? 'Closing...' : 'Close Session'}
                                </button>
                              </>
                            ) : (
                              <button
                                className={styles['start-btn']}
                                onClick={() => handleStart(feature)}
                                disabled={readiness.state === 'blocked' || startingFeature !== null}
                                type="button"
                              >
                                {startingFeature === feature.featureId ? 'Starting...' : 'Start Development'}
                              </button>
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
      ))}
    </div>
  );
};

export const DevWorkbenchView: React.FC = () => {
  const navigate = useNavigate();
  const { selectedProject } = useAppShell();
  const isApex = selectedProject === 'Apex';

  const { data: workItems, isLoading, error } = useAssignedWorkItems(isApex ? null : (selectedProject || null));
  const { data: activeSessions } = useActiveSessions(selectedProject || null);
  const startSession = useStartDevSession();
  const closeSession = useCloseDevSession();
  const [startingId, setStartingId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

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

  if (isApex) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1 className={styles.title}>My Work</h1>
          <p className={styles.subtitle}>Approved PRD features — start a development session to begin coding</p>
        </div>
        <ApexBacklogView project="Apex" activeSessions={activeSessions ?? []} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loading}>Loading assigned work items...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.error}>Failed to load work items: {error.message}</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>My Work</h1>
        <p className={styles.subtitle}>Work items assigned to you — start a development session to begin coding</p>
      </div>

      {startSession.error && (
        <div className={styles.error}>{startSession.error.message}</div>
      )}

      {!workItems || workItems.length === 0 ? (
        <div className={styles.empty}>No active work items assigned to you.</div>
      ) : (
        <div className={styles.list}>
          {sortedWorkItems.map((item) => {
            const active = sessionByWorkItem.get(item.id);
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
                      >
                        Resume Session
                      </button>
                      <button
                        className={styles['close-btn']}
                        onClick={() => handleClose(active.sessionId)}
                        disabled={closingId === active.sessionId}
                        type="button"
                      >
                        {closingId === active.sessionId ? 'Closing...' : 'Close Session'}
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles['start-btn']}
                      onClick={() => handleStart(item.id)}
                      disabled={startingId !== null}
                      type="button"
                    >
                      {startingId === item.id ? 'Starting...' : 'Start Development'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
