import React, { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useHomeDashboard } from '../hooks/useHomeDashboard';
import { HomeDashboardSection } from './HomeDashboardSection';
import styles from './AgentHome.module.css';

interface AgentHomeProps {
  selectedProject: string;
  selectedSkillSettingsId?: string | null;
  isAdmin?: boolean;
  isChatOpen?: boolean;
  canOpenChat?: boolean;
  onOpenChatPanel?: () => void;
  onRestoreThread?: (threadId: string) => void;
}

export const AgentHome: React.FC<AgentHomeProps> = ({
  selectedProject,
  isChatOpen = false,
  canOpenChat = false,
  onOpenChatPanel,
  onRestoreThread,
}) => {
  const [searchParams] = useSearchParams();
  const restoredProjectRef = useRef<string | null>(null);
  const dashboard = useHomeDashboard(selectedProject);

  useEffect(() => {
    if (restoredProjectRef.current === selectedProject) return;
    restoredProjectRef.current = selectedProject;
    const storedThreadId = sessionStorage.getItem(`agentHomeThreadId:${selectedProject}`);
    const threadId = searchParams.get('thread') ?? storedThreadId;
    if (!threadId) return;
    onRestoreThread?.(threadId);
    onOpenChatPanel?.();
  }, [onOpenChatPanel, onRestoreThread, searchParams, selectedProject]);

  return (
    <main className={styles.dashboardPage} {...{ 'data-testid': 'agent-home-dashboard' }}>
      <HomeDashboardSection
        payload={dashboard.data}
        isLoading={dashboard.isLoading}
        onRetry={() => { void dashboard.refetch(); }}
      />
      {canOpenChat && onOpenChatPanel && (
        <button
          type="button"
          className={styles.rightEdgeToggle}
          onClick={onOpenChatPanel}
          aria-label={isChatOpen ? 'Chat panel is open' : 'Open chat panel'}
          aria-expanded={isChatOpen}
          {...{ 'data-testid': 'home-chat-toggle-btn' }}
        >
          <span aria-hidden="true">{isChatOpen ? '‹' : '›'}</span>
          <span className={styles.toggleLabel}>Chat</span>
        </button>
      )}
    </main>
  );
};
