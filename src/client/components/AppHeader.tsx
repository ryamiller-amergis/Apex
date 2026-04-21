import React from 'react';
import { UserMenu } from './UserMenu';

interface AppHeaderProps {
  currentView: 'calendar' | 'planning' | 'cloudcost' | 'backlog';
  planningTab: string;
  availableProjects: string[];
  availableAreaPaths: string[];
  selectedProject: string;
  selectedAreaPath: string;
  isLoading: boolean;
  theme: 'light' | 'dark';
  hasUnreadChangelog: boolean;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onChangeProject: (project: string) => void;
  onChangeAreaPath: (areaPath: string) => void;
  onOpenChangelog: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  currentView,
  availableProjects,
  availableAreaPaths,
  selectedProject,
  selectedAreaPath,
  isLoading,
  theme,
  hasUnreadChangelog,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onChangeProject,
  onChangeAreaPath,
  onOpenChangelog,
  onToggleTheme,
  onLogout,
}) => (
  <div className="app-header">
    <div className="view-switcher">
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
      <div className="selector-group">
        <label htmlFor="project-selector">Project:</label>
        <select
          id="project-selector"
          className="team-selector"
          value={selectedProject}
          onChange={e => onChangeProject(e.target.value)}
          disabled={isLoading}
        >
          {availableProjects.map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      <div className="selector-group">
        <label htmlFor="team-selector">Team:</label>
        <select
          id="team-selector"
          className="team-selector"
          value={selectedAreaPath}
          onChange={e => onChangeAreaPath(e.target.value)}
          disabled={isLoading}
        >
          {availableAreaPaths.map(ap => {
            const displayName = ap.includes('\\') ? ap.split('\\').pop() || ap : ap;
            return <option key={ap} value={ap}>{displayName}</option>;
          })}
        </select>
      </div>
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
