import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useHomeDashboard } from '../hooks/useHomeDashboard';
import { HomeDashboardSection } from './HomeDashboardSection';
import styles from './AgentHome.module.css';

export type HomeView = 'chat' | 'status';

interface AgentHomeProps {
  selectedProject: string;
  isActive?: boolean;
  onHomeViewChange?: (view: HomeView) => void;
  onRestoreThread?: (threadId: string) => void;
}

const storageKey = (project: string) => `apex-home-view:${project}`;

const loadHomeView = (project: string): HomeView => {
  try {
    return localStorage.getItem(storageKey(project)) === 'status' ? 'status' : 'chat';
  } catch {
    return 'chat';
  }
};

export const AgentHome: React.FC<AgentHomeProps> = ({
  selectedProject,
  isActive = true,
  onHomeViewChange,
  onRestoreThread,
}) => {
  const [projectViews, setProjectViews] = useState<Record<string, HomeView>>({});
  const restoredProjectRef = useRef<string | null>(null);
  const restoredUrlThreadRef = useRef<string | null>(null);
  const dashboard = useHomeDashboard(selectedProject, 'team');
  const [searchParams] = useSearchParams();
  const preferredView = projectViews[selectedProject] ?? loadHomeView(selectedProject);
  const threadFromUrl = searchParams.get('thread');
  const statusAvailable = dashboard.data === undefined
    || dashboard.data.incompletePipeline !== null
    || dashboard.data.artifactCycleTime !== null;
  const view = threadFromUrl || (!dashboard.isLoading && !statusAvailable)
    ? 'chat'
    : preferredView;

  const selectView = (nextView: HomeView) => {
    setProjectViews((current) => ({ ...current, [selectedProject]: nextView }));
    try { localStorage.setItem(storageKey(selectedProject), nextView); } catch { /* noop */ }
    onHomeViewChange?.(nextView);
  };

  useEffect(() => {
    if (!isActive) return;
    if (!threadFromUrl) {
      try { localStorage.setItem(storageKey(selectedProject), view); } catch { /* noop */ }
    }
    onHomeViewChange?.(view);
  }, [isActive, onHomeViewChange, selectedProject, threadFromUrl, view]);

  useEffect(() => {
    if (threadFromUrl) {
      if (
        restoredUrlThreadRef.current === threadFromUrl
        && restoredProjectRef.current === selectedProject
      ) {
        return;
      }
      restoredUrlThreadRef.current = threadFromUrl;
      restoredProjectRef.current = selectedProject;
      onRestoreThread?.(threadFromUrl);
      return;
    }

    restoredUrlThreadRef.current = null;
    if (restoredProjectRef.current === selectedProject) return;
    restoredProjectRef.current = selectedProject;
    const storedThreadId = sessionStorage.getItem(`agentHomeThreadId:${selectedProject}`);
    if (storedThreadId) onRestoreThread?.(storedThreadId);
  }, [onRestoreThread, selectedProject, threadFromUrl]);

  return (
    <main className={styles.dashboardPage} data-testid="agent-home-dashboard">
      <div className={styles.tabStrip} role="tablist" aria-label="Home view">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'chat'}
          className={`${styles.tab} ${view === 'chat' ? styles.activeTab : ''}`}
          onClick={() => selectView('chat')}
          data-testid="home-view-chat"
        >
          Chat
        </button>
        {statusAvailable && (
          <button
            type="button"
            role="tab"
            aria-selected={view === 'status'}
            className={`${styles.tab} ${view === 'status' ? styles.activeTab : ''}`}
            onClick={() => selectView('status')}
            data-testid="home-view-status"
          >
            Project status
          </button>
        )}
      </div>
      {view === 'status' && statusAvailable && (
        <div className={styles.statusView} role="tabpanel" aria-label="Project status">
          <HomeDashboardSection
            payload={dashboard.data}
            isLoading={dashboard.isLoading}
            onRetry={() => { void dashboard.refetch(); }}
          />
        </div>
      )}
    </main>
  );
};
