import React, { useState, useCallback, useEffect } from 'react';
import { IS_BETA_RELEASE } from '../config/release';
import { BrandLogo } from './BrandLogo';
import { FeatureRequestFab } from './FeatureRequestFab';
import { FeatureRequestModal } from './FeatureRequestModal';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { useBreakpoint } from '../hooks/useBreakpoint';
import type { ThemeMode } from '../hooks/useAppShell';
import type { ProjectRepoConfigSummary } from '../../shared/types/projectSettings';
import type { WorkItemType } from '../../shared/types/featureRequest';
import styles from './AppHeader.module.css';

interface NavItem {
  label: string;
  view: string;
  permission: string | null;
  onNavigate: () => void;
}

interface AppHeaderProps {
  currentView: 'home' | 'calendar' | 'planning' | 'cloudcost' | 'backlog' | 'adr' | 'notifications' | 'profile' | 'admin' | 'my-work' | 'standup' | 'standup-manage' | 'standup-summary' | 'feature-requests' | 'ui-lab' | 'pdf-tools' | 'ai-cost' | 'design-module' | 'load-tests' | 'diagrams' | 'work-board';
  planningTab: string;
  theme: ThemeMode;
  user: {
    name: string;
    email?: string;
  } | null;
  hasUnreadChangelog: boolean;
  can: (key: string) => boolean;
  isInAnyGroup?: (groups: string[]) => boolean;
  menuEnabledViews?: string[];
  isSuperAdmin?: boolean;
  repoConfigs?: ProjectRepoConfigSummary[];
  selectedSkillSettingsId?: string | null;
  onChangeSkillSettings?: (id: string) => void;
  canAccessHome?: boolean;
  onNavigateHome: () => void;
  onNavigateProjects?: () => void;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onNavigateAdr?: () => void;
  onNavigateMyWork?: () => void;
  onNavigateStandup?: () => void;
  onNavigateUiLab?: () => void;
  onNavigateFeatureRequests?: () => void;
  onNavigateAiCost?: () => void;
  onNavigateDesignModule?: () => void;
  onNavigateLoadTests?: () => void;
  onNavigateDiagrams?: () => void;
  onNavigateWorkBoard?: () => void;
  onNavigateAdmin: () => void;
  onOpenChangelog: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  selectedProject?: string;
  onLogout: () => void;
  onOpenAgentChat?: () => void;
}

export const AppHeader: React.FC<AppHeaderProps> = ({
  currentView,
  theme,
  user,
  hasUnreadChangelog,
  can,
  isInAnyGroup,
  menuEnabledViews = [],
  isSuperAdmin = false,
  repoConfigs = [],
  selectedSkillSettingsId,
  onChangeSkillSettings,
  canAccessHome = true,
  onNavigateHome,
  onNavigateProjects,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onNavigateAdr = () => {},
  onNavigateMyWork,
  onNavigateStandup,
  onNavigateUiLab,
  onNavigateFeatureRequests,
  onNavigateAiCost,
  onNavigateDesignModule,
  onNavigateLoadTests,
  onNavigateDiagrams,
  onNavigateWorkBoard,
  onNavigateAdmin,
  onOpenChangelog,
  onThemeChange,
  onLogout,
  selectedProject,
  onOpenAgentChat: _onOpenAgentChat,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [workItemType, setWorkItemType] = useState<WorkItemType | null>(null);
  const { isMobile } = useBreakpoint();

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen, closeMenu]);

  // Close the mobile drawer when the viewport leaves mobile — adjust during render
  // to avoid a cascading setState-in-effect when the breakpoint flips.
  if (!isMobile && menuOpen) {
    setMenuOpen(false);
  }

  const navItems: NavItem[] = [
    { label: 'Home', view: 'home', permission: null, onNavigate: onNavigateHome },
    { label: 'Calendar', view: 'calendar', permission: 'calendar:view', onNavigate: onNavigateCalendar },
    { label: 'Planning', view: 'planning', permission: 'planning:view', onNavigate: onNavigatePlanning },
    { label: 'Cloud Cost', view: 'cloudcost', permission: 'cost:view', onNavigate: onNavigateCloudCost },
    { label: 'AI Cost Analytics', view: 'ai-cost', permission: 'analytics:ai-cost:view', onNavigate: onNavigateAiCost ?? (() => {}) },
    { label: 'Interview', view: 'backlog', permission: 'interviews:view', onNavigate: onNavigateBacklog },
    { label: 'ADR', view: 'adr', permission: 'adr:view', onNavigate: onNavigateAdr },
    { label: 'My Work', view: 'my-work', permission: 'dev-workbench:view', onNavigate: onNavigateMyWork ?? (() => {}) },
    { label: 'Standup', view: 'standup', permission: 'standup:participate', onNavigate: onNavigateStandup ?? (() => {}) },
    { label: 'UI Lab', view: 'ui-lab', permission: 'ui-lab:view', onNavigate: onNavigateUiLab ?? (() => {}) },
    { label: 'Apex Backlog', view: 'feature-requests', permission: 'feature-requests:view', onNavigate: onNavigateFeatureRequests ?? (() => {}) },
    { label: 'Design Module', view: 'design-module', permission: 'design-module:view', onNavigate: onNavigateDesignModule ?? (() => {}) },
    { label: 'Diagrams', view: 'diagrams', permission: 'diagram:view', onNavigate: onNavigateDiagrams ?? (() => {}) },
    { label: 'Load Tests', view: 'load-tests', permission: 'load-test:view', onNavigate: onNavigateLoadTests ?? (() => {}) },
    { label: 'Work Board', view: 'work-board', permission: 'work-board:view', onNavigate: onNavigateWorkBoard ?? (() => {}) },
    { label: 'Admin', view: 'admin', permission: 'admin:roles', onNavigate: onNavigateAdmin },
  ];

  const visibleNavItems = navItems.filter((item) => {
    if (item.view === 'home') return canAccessHome;
    if (item.view === 'admin') return can('admin:roles');
    if (item.view === 'my-work') {
      if (!isSuperAdmin && !menuEnabledViews.includes('my-work')) return false;
      return can('dev-workbench:view') && (isInAnyGroup?.(['Developer']) ?? false);
    }
    if (item.view === 'standup') {
      if (!isSuperAdmin && !menuEnabledViews.includes('standup')) return false;
      if (!isSuperAdmin && !can('standup:participate')) return false;
      return true;
    }
    if (item.view === 'feature-requests') {
      if (!isSuperAdmin && !menuEnabledViews.includes('feature-requests')) return false;
      if (!isSuperAdmin && !can('feature-requests:view')) return false;
      return true;
    }
    if (item.view === 'work-board') {
      if (!isSuperAdmin && !menuEnabledViews.includes('work-board')) return false;
      return isSuperAdmin || can('work-board:view');
    }
    if (item.view === 'ui-lab') {
      if (!isSuperAdmin && !menuEnabledViews.includes('ui-lab')) return false;
      if (!isSuperAdmin && !can('ui-lab:view')) return false;
      return isSuperAdmin || (isInAnyGroup?.(['UI/UX']) ?? false);
    }
    if (!isSuperAdmin && !menuEnabledViews.includes(item.view)) return false;
    if (!isSuperAdmin && item.permission !== null && !can(item.permission)) return false;
    return true;
  });

  const handleMobileNavClick = (onNavigate: () => void) => {
    onNavigate();
    closeMenu();
  };

  return (
    <div className="app-header">
      <div className="header-main">
        <button
          className="app-brand"
          onClick={onNavigateProjects ?? onNavigateHome}
          type="button"
          aria-label={
            selectedProject
              ? `Select an Apex project (current: ${selectedProject})`
              : 'Select an Apex project'
          }
          title="Select project"
          {...{ 'data-testid': 'app-header-brand' }}
        >
          <BrandLogo variant="mark" className="app-brand-mark" beta={IS_BETA_RELEASE} />
          <span className="app-brand-text">
            <span>Apex</span>
            {selectedProject && (
              <>
                <span className="app-brand-separator" aria-hidden="true">
                  ·
                </span>
                <span className="app-brand-project">{selectedProject}</span>
              </>
            )}
            {IS_BETA_RELEASE && <span className="app-brand-beta">BETA</span>}
          </span>
        </button>

        {isMobile && (
          <button
            className={styles['hamburger-btn']}
            onClick={() => setMenuOpen(true)}
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
            {...{ 'data-testid': 'app-header-hamburger' }}
          >
            <span className={styles['hamburger-icon']} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        )}
      </div>

      <div className="header-controls">
        {repoConfigs.length > 1 && onChangeSkillSettings && (
          <div className={styles['repo-switcher-group']}>
            <span className={styles['repo-switcher-label']}>Repo Project -</span>
            <select
              className={styles['repo-switcher']}
              value={selectedSkillSettingsId ?? ''}
              onChange={(e) => onChangeSkillSettings(e.target.value)}
              {...{ 'data-testid': 'app-header-repo-switcher' }}
            >
              {repoConfigs.map((cfg) => (
                <option key={cfg.id} value={cfg.id}>
                  {cfg.friendlyName}
                </option>
              ))}
            </select>
          </div>
        )}
        {can('notifications:view') && <NotificationBell />}
        {/* data-testid-exempt — pre-existing UserMenu; FEAT-006 Help lives on Apex Fab */}
        <UserMenu
          onOpenChangelog={onOpenChangelog}
          onThemeChange={onThemeChange}
          onLogout={onLogout}
          theme={theme}
          user={user}
          hasUnreadChangelog={hasUnreadChangelog}
        />
      </div>

      {isMobile && (
        <>
          <div
            className={`${styles['mobile-nav-overlay']} ${menuOpen ? styles['open'] : ''}`}
            onClick={closeMenu}
            aria-hidden="true"
            // data-testid-exempt — decorative dismiss overlay; close control is the explicit button
          />
          <nav
            className={`${styles['mobile-nav']} ${menuOpen ? styles['open'] : ''}`}
            aria-label="Mobile navigation"
          >
            <div className={styles['mobile-nav-header']}>
              <BrandLogo variant="mark" className="app-brand-mark" beta={IS_BETA_RELEASE} />
              <button
                className={styles['close-btn']}
                onClick={closeMenu}
                type="button"
                aria-label="Close navigation menu"
                {...{ 'data-testid': 'app-header-mobile-nav-close' }}
              >
                &#x2715;
              </button>
            </div>
            <div className={styles['mobile-nav-items']}>
              {visibleNavItems.map((item) => (
                <button
                  key={item.view}
                  className={`${styles['mobile-nav-item']} ${currentView === item.view ? styles['active'] : ''}`}
                  onClick={() => handleMobileNavClick(item.onNavigate)}
                  type="button"
                  {...{ 'data-testid': `app-header-mobile-nav-${item.view}` }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        </>
      )}

      {selectedProject && (
        <FeatureRequestFab
          onSubmit={setWorkItemType}
          projectId={selectedProject}
          canSubmitWorkItems={can('feature-requests:submit')}
          {...{ 'data-testid': 'apex-feature-request-fab' }}
        />
      )}

      {workItemType && selectedProject && (
        // data-testid-exempt — FAB submissions always target the Apex project (platform triage queue)
        <FeatureRequestModal
          selectedProject="Apex"
          type={workItemType}
          onClose={() => setWorkItemType(null)}
        />
      )}
    </div>
  );
};
