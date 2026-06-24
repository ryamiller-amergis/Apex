import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import { useAssignedWorkItems, useStartDevSession, useActiveSessions, useCloseDevSession } from '../hooks/useDevWorkbench';
import styles from './DevWorkbenchView.module.css';

export const DevWorkbenchView: React.FC = () => {
  const navigate = useNavigate();
  const { selectedProject } = useAppShell();
  const { data: workItems, isLoading, error } = useAssignedWorkItems(selectedProject || null);
  const { data: activeSessions } = useActiveSessions(selectedProject || null);
  const startSession = useStartDevSession();
  const closeSession = useCloseDevSession();
  const [startingId, setStartingId] = useState<number | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);

  const sessionByWorkItem = useMemo(() => {
    const map = new Map<number, { sessionId: string }>();
    if (activeSessions) {
      for (const s of activeSessions) {
        if (s.status !== 'closed' && s.status !== 'failed') {
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
