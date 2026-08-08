import React from 'react';
import { useBreakpoint } from '../hooks/useBreakpoint';
import styles from './AppSidebar.module.css';

interface NavItem {
  label: string;
  view: string;
  icon: React.ReactNode;
  permission: string | null;
  onNavigate: () => void;
  /** Rare override when the id cannot follow `nav-item-${view}` (e.g. Load Tests). */
  testId?: string;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

/** Spread props for sidebar module buttons — Sync resolves `view:` → `nav-item-${view}`. */

interface AppSidebarProps {
  currentView: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  can: (key: string) => boolean;
  isInAnyGroup?: (groups: string[]) => boolean;
  menuEnabledViews?: string[];
  isSuperAdmin?: boolean;
  selectedProject?: string;
  canAccessHome?: boolean;
  onNavigateHome: () => void;
  onNavigateCalendar: () => void;
  onNavigatePlanning: () => void;
  onNavigateCloudCost: () => void;
  onNavigateBacklog: () => void;
  onNavigateAdr?: () => void;
  onNavigateMyWork?: () => void;
  onNavigateStandup?: () => void;
  onNavigateUiLab?: () => void;
  onNavigateFeatureRequests?: () => void;
  onNavigatePdfTools?: () => void;
  onNavigateAiCost?: () => void;
  onNavigateDesignModule?: () => void;
  onNavigateWorkBoard?: () => void;
  onNavigateLoadTests?: () => void;
  onNavigateDiagrams?: () => void;
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

const IconAdr: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 2.5h7l3 3V17.5H5z" />
    <path d="M12 2.5v3h3M8 9h4M8 12h4" />
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
    <rect x="4" y="2" width="12" height="16" rx="1.5" />
    <path d="M7 6h6M7 9h6M7 12h4" />
  </svg>
);

const IconDesignModule: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="5" height="5" rx="1" />
    <rect x="12" y="3" width="5" height="5" rx="1" />
    <rect x="7.5" y="12" width="5" height="5" rx="1" />
    <path d="M5.5 8v2h9V8M10 10v2" />
  </svg>
);

const IconWorkBoard: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="4" height="12" rx="1" />
    <rect x="8" y="4" width="4" height="9" rx="1" />
    <rect x="14" y="4" width="4" height="6" rx="1" />
  </svg>
);

const IconLoadTests: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 3a7 7 0 100 14A7 7 0 0010 3z" />
    <path d="M10 7v3l2 2" />
    <path d="M3.5 10h1M15.5 10h1M10 3.5v1M10 15.5v1" />
  </svg>
);

const IconDiagrams: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="14" height="12" rx="2" />
    <path d="M6 13l3-4 2.5 3L14 9l2 4" />
  </svg>
);

const IconAiCost: React.FC = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v1.5M10 12.5V14M8.25 8.5A1.75 1.75 0 0110 7h.5a1.5 1.5 0 010 3h-1a1.5 1.5 0 000 3h.5A1.75 1.75 0 0011.75 11.5" />
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
  canAccessHome = true,
  onNavigateHome,
  onNavigateCalendar,
  onNavigatePlanning,
  onNavigateCloudCost,
  onNavigateBacklog,
  onNavigateAdr = () => {},
  onNavigateMyWork,
  onNavigateStandup,
  onNavigateUiLab,
  onNavigateFeatureRequests,
  onNavigatePdfTools,
  onNavigateAiCost,
  onNavigateDesignModule,
  onNavigateWorkBoard,
  onNavigateLoadTests,
  onNavigateDiagrams,
  onNavigateAdmin,
}) => {
  const { isMobile } = useBreakpoint();

  if (isMobile) return null;

  const moduleGroups: NavGroup[] = [
    {
      id: 'build',
      label: 'Build',
      items: [
        { label: 'Interview', view: 'backlog', icon: <IconInterview />, permission: 'interviews:view', onNavigate: onNavigateBacklog },
        { label: 'ADR', view: 'adr', icon: <IconAdr />, permission: 'adr:view', onNavigate: onNavigateAdr },
        { label: 'Design Module', view: 'design-module', icon: <IconDesignModule />, permission: 'design-module:view', onNavigate: onNavigateDesignModule ?? (() => {}) },
        { label: 'My Work', view: 'my-work', icon: <IconMyWork />, permission: 'dev-workbench:view', onNavigate: onNavigateMyWork ?? (() => {}) },
        { label: 'Diagrams', view: 'diagrams', icon: <IconDiagrams />, permission: 'diagram:view', onNavigate: onNavigateDiagrams ?? (() => {}), testId: 'nav-diagrams' },
      ],
    },
    {
      id: 'delivery',
      label: 'Delivery',
      items: [
        { label: 'Calendar', view: 'calendar', icon: <IconCalendar />, permission: 'calendar:view', onNavigate: onNavigateCalendar },
        { label: 'Standup', view: 'standup', icon: <IconStandup />, permission: 'standup:participate', onNavigate: onNavigateStandup ?? (() => {}) },
      ],
    },
    {
      id: 'insights',
      label: 'Insights',
      items: [
        { label: 'Planning', view: 'planning', icon: <IconPlanning />, permission: 'planning:view', onNavigate: onNavigatePlanning },
        { label: 'Cloud Cost', view: 'cloudcost', icon: <IconCloud />, permission: 'cost:view', onNavigate: onNavigateCloudCost },
        { label: 'AI Cost', view: 'ai-cost', icon: <IconAiCost />, permission: 'analytics:ai-cost:view', onNavigate: onNavigateAiCost ?? (() => {}) },
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      items: [
        { label: 'UI Lab', view: 'ui-lab', icon: <IconUiLab />, permission: 'ui-lab:view', onNavigate: onNavigateUiLab ?? (() => {}) },
        { label: 'PDF Assembly Tool', view: 'pdf-tools', icon: <IconPdfTools />, permission: 'pdf-assembly:use', onNavigate: onNavigatePdfTools ?? (() => {}) },
        { label: 'Load Tests', view: 'load-tests', icon: <IconLoadTests />, permission: 'load-test:view', onNavigate: onNavigateLoadTests ?? (() => {}), testId: 'nav-load-tests' },
        { label: 'Apex Backlog', view: 'feature-requests', icon: <IconFeatureRequests />, permission: 'feature-requests:view', onNavigate: onNavigateFeatureRequests ?? (() => {}) },
        { label: 'Work Board', view: 'work-board', icon: <IconWorkBoard />, permission: null, onNavigate: onNavigateWorkBoard ?? (() => {}) },
      ],
    },
  ];

  const isItemVisible = (item: NavItem): boolean => {
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
      if (!isSuperAdmin) return false;
      if (selectedProject !== 'Apex') return false;
      return true;
    }
    if (item.view === 'pdf-tools') {
      if (!isSuperAdmin && !menuEnabledViews.includes('pdf-tools')) return false;
      if (!isSuperAdmin && !can('pdf-assembly:use')) return false;
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
  };

  const visibleGroups = moduleGroups
    .map((group) => ({ ...group, items: group.items.filter(isItemVisible) }))
    .filter((group) => group.items.length > 0);

  const showAdmin = can('admin:roles');

  const isActive = (view: string) => {
    if (view === 'home') return currentView === 'home';
    if (view === 'standup') return currentView === 'standup' || currentView === 'standup-manage' || currentView === 'standup-summary';
    if (view === 'work-board') return currentView === 'work-board';
    return currentView === view;
  };

  return (
    <nav
      className={`${styles.sidebar} ${collapsed ? styles.collapsed : styles.expanded}`}
      aria-label="Main navigation"
    >
      {canAccessHome && (
        <div className={styles.top}>
          <button
            className={`${styles.navItem} ${isActive('home') ? styles.active : ''}`}
            onClick={onNavigateHome}
            type="button"
            title={collapsed ? 'Home' : undefined}
            {...{ 'data-testid': 'nav-item-home' }}
          >
            <span className={styles.icon}><IconHome /></span>
            {!collapsed && <span className={styles.label}>Home</span>}
          </button>
        </div>
      )}

      <div className={styles.divider} />

      <div className={styles.modules}>
        {visibleGroups.map((group, groupIdx) => (
          <div key={group.id} className={styles.group}>
            {groupIdx > 0 && collapsed && <div className={styles.groupDivider} />}
            {!collapsed && (
              <div className={styles.groupLabel} aria-hidden="true">{group.label}</div>
            )}
            {group.items.map((item) => (
              <button
                key={item.view}
                className={`${styles.navItem} ${isActive(item.view) ? styles.active : ''}`}
                onClick={item.onNavigate}
                type="button"
                title={collapsed ? item.label : undefined}
                {...{ 'data-testid': item.testId ?? `nav-item-${item.view}` }}
              >
                <span className={styles.icon}>{item.icon}</span>
                {!collapsed && <span className={styles.label}>{item.label}</span>}
              </button>
            ))}
          </div>
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
              {...{ 'data-testid': 'nav-item-admin' }}
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
          {...{ 'data-testid': 'sidebar-collapse-btn' }}
        >
          {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          {!collapsed && <span className={styles.collapseLabel}>Collapse</span>}
        </button>
      </div>
    </nav>
  );
};
