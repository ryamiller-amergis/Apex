import React, { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { HomeDashboardScope } from '../../shared/types/homeDashboard';
import { useHomeDashboard } from '../hooks/useHomeDashboard';
import type { WorkItem } from '../types/workitem';
import { HomeDashboardSection } from './HomeDashboardSection';
import styles from './AgentHome.module.css';

interface AgentHomeProps {
  selectedProject: string;
  selectedAreaPath?: string;
  selectedSkillSettingsId?: string | null;
  isAdmin?: boolean;
  isChatOpen?: boolean;
  canOpenChat?: boolean;
  onOpenChatPanel?: () => void;
  onRestoreThread?: (threadId: string) => void;
  onSelectWorkItem?: (workItem: WorkItem) => void;
}

export const AgentHome: React.FC<AgentHomeProps> = ({
  selectedProject,
  selectedAreaPath = '',
  isChatOpen = false,
  canOpenChat = false,
  onOpenChatPanel,
  onRestoreThread,
  onSelectWorkItem,
}) => {
  const [dashboardScope, setDashboardScope] = useState<HomeDashboardScope>('mine');
  const restoredProjectRef = useRef<string | null>(null);
  const bugDetails = useMutation({
    mutationFn: async (pbiId: string): Promise<WorkItem> => {
      const params = new URLSearchParams({
        project: selectedProject,
        areaPath: selectedAreaPath,
      });
      const response = await fetch(`/api/workitems/${encodeURIComponent(pbiId)}?${params}`, {
        credentials: 'include',
      });
      if (!response.ok) throw new Error('Could not load this PBI.');
      return response.json() as Promise<WorkItem>;
    },
    onSuccess: (workItem) => onSelectWorkItem?.(workItem),
  });
  const dashboard = useHomeDashboard(selectedProject, dashboardScope);
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (restoredProjectRef.current === selectedProject) return;
    restoredProjectRef.current = selectedProject;
    // Restore remembered thread identity without opening the drawer. Only an
    // explicit Home deep link should open chat on initial load.
    const threadFromUrl = searchParams.get('thread');
    const storedThreadId = sessionStorage.getItem(`agentHomeThreadId:${selectedProject}`);
    const threadId = threadFromUrl ?? storedThreadId;
    if (!threadId) return;
    onRestoreThread?.(threadId);
    if (threadFromUrl) onOpenChatPanel?.();
  }, [onOpenChatPanel, onRestoreThread, searchParams, selectedProject]);

  return (
    <main className={styles.dashboardPage} {...{ 'data-testid': 'agent-home-dashboard' }}>
      <HomeDashboardSection
        payload={dashboard.data}
        isLoading={dashboard.isLoading}
        onRetry={() => { void dashboard.refetch(); }}
        scope={dashboardScope}
        onScopeChange={setDashboardScope}
        onSelectBugPbi={(pbiId) => bugDetails.mutate(pbiId)}
      />
      {bugDetails.isError && (
        <div className={styles.dashboardError} role="alert">
          Could not open that PBI. Retry from the Open Bugs list.
        </div>
      )}
      {canOpenChat && onOpenChatPanel && (
        <button
          type="button"
          className={styles.rightEdgeToggle}
          onClick={onOpenChatPanel}
          aria-label={isChatOpen ? 'Chat panel is open' : 'Open chat panel'}
          aria-expanded={isChatOpen}
          {...{ 'data-testid': 'home-chat-toggle-btn' }}
        >
          <svg className={styles.toggleIcon} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <rect x="2.75" y="3.75" width="14.5" height="10.5" rx="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M6 14.25V17.5L9.75 14.25Z" fill="currentColor" />
            <circle cx="7" cy="9" r="1" fill="currentColor" />
            <circle cx="10" cy="9" r="1" fill="currentColor" />
            <circle cx="13" cy="9" r="1" fill="currentColor" />
          </svg>
          <span className={styles.toggleLabel}>Chat</span>
        </button>
      )}
    </main>
  );
};
