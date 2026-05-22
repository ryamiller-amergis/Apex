import React from 'react';
import { BrandLogo } from './BrandLogo';
import { UserMenu } from './UserMenu';
import type { ThemeMode } from '../hooks/useAppShell';

interface AppHeaderProps {
  currentView: 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'admin';
  planningTab: string;
  theme: ThemeMode;
  user: {
    name: string;
    email?: string;
  } | null;
  hasUnreadChangelog: boolean;
  can: (key: string) => boolean;
  onNavigateHome: () => void;
  onNavigateProjects?: () => void;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onNavigateAdmin: () => void;
  onOpenChangelog: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLogout: () => void;
  onOpenAgentChat?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  currentView,
  theme,
  user,
  hasUnreadChangelog,
  can,
  onNavigateHome,
  onNavigateProjects,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onNavigateAdmin,
  onOpenChangelog,
  onThemeChange,
  onLogout,
  onOpenAgentChat,
}) => (
  <div className="app-header">
    <div className="header-main">
      <button
        className="app-brand"
        onClick={onNavigateProjects ?? onNavigateHome}
        type="button"
        aria-label="Select an Apex project"
        title="Select project"
      >
        <BrandLogo variant="mark" className="app-brand-mark" />
        <span className="app-brand-text">Apex</span>
      </button>
      <div className="view-switcher">
        <button
          className={`view-btn ${currentView === 'home' ? 'active' : ''}`}
          onClick={onNavigateHome}
        >
          Home
        </button>
        {can('calendar:view') && (
          <button
            className={`view-btn ${currentView === 'calendar' ? 'active' : ''}`}
            onClick={onNavigateCalendar}
          >
            Calendar
          </button>
        )}
        {can('planning:view') && (
          <button
            className={`view-btn ${currentView === 'planning' ? 'active' : ''}`}
            onClick={onNavigatePlanning}
          >
            Planning
          </button>
        )}
        {can('cost:view') && (
          <button
            className={`view-btn ${currentView === 'cloudcost' ? 'active' : ''}`}
            onClick={onNavigateCloudCost}
          >
            Cloud Cost
          </button>
        )}
        {can('interviews:view') && (
          <button
            className={`view-btn ${currentView === 'backlog' ? 'active' : ''}`}
            onClick={onNavigateBacklog}
          >
            Interview
          </button>
        )}
        {can('admin:roles') && (
          <button
            className={`view-btn ${currentView === 'admin' ? 'active' : ''}`}
            onClick={onNavigateAdmin}
          >
            Admin
          </button>
        )}
      </div>
    </div>
    <div className="header-controls">
      {onOpenAgentChat && can('chat:view') && (
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
        onThemeChange={onThemeChange}
        onLogout={onLogout}
        theme={theme}
        user={user}
        hasUnreadChangelog={hasUnreadChangelog}
      />
    </div>
  </div>
);
