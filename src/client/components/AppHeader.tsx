import React from 'react';
import { UserMenu } from './UserMenu';

interface AppHeaderProps {
  currentView: 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog';
  planningTab: string;
  theme: 'light' | 'dark';
  hasUnreadChangelog: boolean;
  onNavigateHome: () => void;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onOpenChangelog: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  onOpenAgentChat?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  currentView,
  theme,
  hasUnreadChangelog,
  onNavigateHome,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onOpenChangelog,
  onToggleTheme,
  onLogout,
  onOpenAgentChat,
}) => (
  <div className="app-header">
    <div className="view-switcher">
      <button
        className={`view-btn ${currentView === 'home' ? 'active' : ''}`}
        onClick={onNavigateHome}
      >
        Home
      </button>
      <button
        className={`view-btn ${currentView === 'calendar' ? 'active' : ''}`}
        onClick={onNavigateCalendar}
      >
        Calendar
      </button>
      <button
        className={`view-btn ${currentView === 'planning' ? 'active' : ''}`}
        onClick={onNavigatePlanning}
      >
        Planning
      </button>
      <button
        className={`view-btn ${currentView === 'cloudcost' ? 'active' : ''}`}
        onClick={onNavigateCloudCost}
      >
        Cloud Cost
      </button>
      <button
        className={`view-btn ${currentView === 'backlog' ? 'active' : ''}`}
        onClick={onNavigateBacklog}
      >
        Backlog
      </button>
    </div>
    <div className="header-controls">
      {onOpenAgentChat && (
        <button
          className="agent-launch-btn"
          onClick={onOpenAgentChat}
          title="Open Agent Studio"
        >
          <span className="agent-launch-mark" aria-hidden="true">
            <svg viewBox="0 0 18 18" fill="none">
              <path d="M9 2.25l1.2 3.3 3.3 1.2-3.3 1.2L9 11.25l-1.2-3.3-3.3-1.2 3.3-1.2L9 2.25z" />
              <path d="M13 11l.6 1.6 1.65.65-1.65.6L13 15.5l-.6-1.65-1.65-.6 1.65-.65L13 11z" />
            </svg>
          </span>
          <span>Agent Studio</span>
        </button>
      )}
      <UserMenu
        onOpenChangelog={onOpenChangelog}
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
        theme={theme}
        hasUnreadChangelog={hasUnreadChangelog}
      />
    </div>
  </div>
);
