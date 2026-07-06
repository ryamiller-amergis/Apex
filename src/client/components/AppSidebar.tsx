import React from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import styles from './AppSidebar.module.css';

interface NavItem {
  label: string;
  view: string;
  icon: React.ReactNode;
  permission: string | null;
  onNavigate: () => void;
}

interface AppSidebarProps {
  currentView: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  can: (key: string) => boolean;
  isInAnyGroup?: (groups: string[]) => boolean;
  menuEnabledViews?: string[];
  isSuperAdmin?: boolean;
  selectedProject?: string;
  onNavigateHome: () => void;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onNavigateMyWork?: () => void;
  onNavigateStandup?: () => void;
  onNavigateUiLab?: () => void;
  onNavigateFeatureRequests?: () => void;
  onNavigatePdfTools?: () => void;
  onNavigateAdmin: () => void;
}

const IconHome: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 10.5L10 4l7 6.5" />
    <path d="M5 9.5V16a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V9.5" />
  </svg>
);

const IconCalendar: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="14" height="13" rx="2" />
    <path d="M3 8h14" />
    <path d="M7 2v4M13 2v4" />
  </svg>
);

const IconPlanning: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="12" width="3" height="5" rx="0.5" />
    <rect x="8.5" y="8" width="3" height="9" rx="0.5" />
    <rect x="14" y="4" width="3" height="13" rx="0.5" />
  </svg>
);

const IconCloud: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6.5 15.5h8a3.5 3.5 0 00.5-6.96 5 5 0 00-9.7 1.46A3 3 0 006.5 15.5z" />
  </svg>
);

const IconInterview: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5a2 2 0 012-2h8a2 2 0 012 2v7a2 2 0 01-2 2H8l-3 3v-3H6a2 2 0 01-2-2V5z" />
    <path d="M7 7h6M7 10h4" />
  </svg>
);

const IconMyWork: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="14" height="10" rx="2" />
    <path d="M7 7V5a3 3 0 016 0v2" />
  </svg>
);

const IconStandup: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="13" cy="5.5" r="2" />
    <path d="M3.5 17v-3.5a3.5 3.5 0 017 0V17" />
    <path d="M9.5 17v-3.5a3.5 3.5 0 017 0V17" />
  </svg>
);

const IconUiLab: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M3 8h14" />
    <path d="M6 6h.01" />
    <path d="M7 12l2 2 4-4" />
  </svg>
);

const IconFeatureRequests: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3a4 4 0 014 4c0 1.5-.8 2.5-1.5 3.3-.5.5-.5 1-.5 1.7h-4c0-.7 0-1.2-.5-1.7C6.8 9.5 6 8.5 6 7a4 4 0 014-4z" />
    <path d="M8 14h4M8.5 16h3" />
  </svg>
);

const IconPdfTools: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="2" width="12" height="16" rx="2" />
    <path d="M7 7h6M7 10h6M7 13h4" />
  </svg>
);

const IconAdmin: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="3" />
    <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
  </svg>
);

const IconChevronLeft: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3L5 8l5 5" />
  </svg>
);

const IconChevronRight: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M6 3l5 5-5 5" />
  </svg>
);

export const AppSidebar: React.FC<AppSidebarProps> = ({
  currentView,
  collapsed,
  onToggleCollapsed,
  can,
  isInAnyGroup,
  menuEnabledViews = [],
  isSuperAdmin = false,
  selectedProject,
  onNavigateHome,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onNavigateMyWork,
  onNavigateStandup,
  onNavigateUiLab,
  onNavigateFeatureRequests,
  onNavigatePdfTools,
  onNavigateAdmin,
}) => {
  const { isMobile } = useBreakpoint();

  if (isMobile) return null;

  const moduleItems: NavItem[] = [
    { label: 'Calendar', view: 'calendar', icon: <IconCalendar />, permission: 'calendar:view', onNavigate: onNavigateCalendar },
    { label: 'Planning', view: 'planning', icon: <IconPlanning />, permission: 'planning:view', onNavigate: onNavigatePlanning },
    { label: 'Cloud Cost', view: 'cloudcost', icon: <IconCloud />, permission: 'cost:view', onNavigate: onNavigateCloudCost },
    { label: 'Interview', view: 'backlog', icon: <IconInterview />, permission: 'interviews:view', onNavigate: onNavigateBacklog },
    { label: 'My Work', view: 'my-work', icon: <IconMyWork />, permission: 'dev-workbench:view', onNavigate: onNavigateMyWork ?? (() => {}) },
    { label: 'Standup', view: 'standup', icon: <IconStandup />, permission: 'standup:participate', onNavigate: onNavigateStandup ?? (() => {}) },
    { label: 'UI Lab', view: 'ui-lab', icon: <IconUiLab />, permission: 'ui-lab:view', onNavigate: onNavigateUiLab ?? (() => {}) },
    { label: 'Feature Requests', view: 'feature-requests', icon: <IconFeatureRequests />, permission: 'feature-requests:view', onNavigate: onNavigateFeatureRequests ?? (() => {}) },
    { label: 'PDF Tools', view: 'pdf-tools', icon: <IconPdfTools />, permission: 'pdf-assembly:use', onNavigate: onNavigatePdfTools ?? (() => {}) },
  ];

  const visibleModuleItems = moduleItems.filter((item) => {
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
      if (selectedProject !== 'Apex') return false;
      if (!isSuperAdmin && !menuEnabledViews.includes('feature-requests')) return false;
      if (!isSuperAdmin && !can('feature-requests:view')) return false;
      return true;
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

  const showAdmin = can('admin:roles');

  const isActive = (view: string) => {
    if (view === 'home') return currentView === 'home';
    if (view === 'standup') return currentView === 'standup' || currentView === 'standup-manage' || currentView === 'standup-summary';
    return currentView === view;
  };

  return (
    <nav
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : styles.expanded}`}
      aria-label="Main navigation"
    >
      <div className={styles.top}>
        <button
          className={`${styles.navItem} ${isActive('home') ? styles.active : ''}`}
          onClick={onNavigateHome}
          type="button"
          title={collapsed ? 'Home' : undefined}
        >
          <span className={styles.icon}><IconHome /></span>
          {!collapsed && <span className={styles.label}>Home</span>}
        </button>
      </div>

      <div className={styles.divider} />

      <div className={styles.modules}>
        {visibleModuleItems.map((item) => (
          <button
            key={item.view}
            className={`${styles.navItem} ${isActive(item.view) ? styles.active : ''}`}
            onClick={item.onNavigate}
            type="button"
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            data-testid={`nav-item-${item.view}`}
          >
            <span className={styles.icon}>{item.icon}</span>
            {!collapsed && <span className={styles.label}>{item.label}</span>}
          </button>
        ))}
      </div>

      <div className={styles.bottom}>
        {showAdmin && (
          <>
            <div className={styles.divider} />
            <button
              className={`${styles.navItem} ${isActive('admin') ? styles.active : ''}`}
              onClick={onNavigateAdmin}
              type="button"
              title={collapsed ? 'Admin' : undefined}
            >
              <span className={styles.icon}><IconAdmin /></span>
              {!collapsed && <span className={styles.label}>Admin</span>}
            </button>
          </>
        )}
        <div className={styles.divider} />
        <button
          className={styles.collapseBtn}
          onClick={onToggleCollapsed}
          type="button"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          {!collapsed && <span className={styles.collapseLabel}>Collapse</span>}
        </button>
      </div>
    </nav>
  );
};
