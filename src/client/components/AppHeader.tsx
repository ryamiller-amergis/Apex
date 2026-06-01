import React, { useState, useCallback, useEffect } from 'react';
import { BrandLogo } from './BrandLogo';
import { NotificationBell } from './NotificationBell';
import { UserMenu } from './UserMenu';
import { useBreakpoint } from '../hooks/useBreakpoint';
import type { ThemeMode } from '../hooks/useAppShell';
import styles from './AppHeader.module.css';

interface NavItem {
  label: string;
  view: string;
  permission: string | null;
  onNavigate: () => void;
}

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
  onOpenAgentChat: _onOpenAgentChat,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
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

  useEffect(() => {
    if (!isMobile && menuOpen) closeMenu();
  }, [isMobile, menuOpen, closeMenu]);

  const navItems: NavItem[] = [
    { label: 'Home', view: 'home', permission: null, onNavigate: onNavigateHome },
    { label: 'Calendar', view: 'calendar', permission: 'calendar:view', onNavigate: onNavigateCalendar },
    { label: 'Planning', view: 'planning', permission: 'planning:view', onNavigate: onNavigatePlanning },
    { label: 'Cloud Cost', view: 'cloudcost', permission: 'cost:view', onNavigate: onNavigateCloudCost },
    { label: 'Interview', view: 'backlog', permission: 'interviews:view', onNavigate: onNavigateBacklog },
    { label: 'Admin', view: 'admin', permission: 'admin:roles', onNavigate: onNavigateAdmin },
  ];

  const visibleNavItems = navItems.filter(
    (item) => item.permission === null || can(item.permission),
  );

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
          aria-label="Select an Apex project"
          title="Select project"
        >
          <BrandLogo variant="mark" className="app-brand-mark" />
          <span className="app-brand-text">Apex</span>
        </button>

        {isMobile ? (
          <button
            className={styles['hamburger-btn']}
            onClick={() => setMenuOpen(true)}
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={menuOpen}
          >
            <span className={styles['hamburger-icon']} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
        ) : (
          <div className="view-switcher">
            {visibleNavItems.map((item) => (
              <button
                key={item.view}
                className={`view-btn ${currentView === item.view ? 'active' : ''}`}
                onClick={item.onNavigate}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="header-controls">
        {can('notifications:view') && <NotificationBell />}
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
          />
          <nav
            className={`${styles['mobile-nav']} ${menuOpen ? styles['open'] : ''}`}
            aria-label="Mobile navigation"
          >
            <div className={styles['mobile-nav-header']}>
              <BrandLogo variant="mark" className="app-brand-mark" />
              <button
                className={styles['close-btn']}
                onClick={closeMenu}
                type="button"
                aria-label="Close navigation menu"
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
                >
                  {item.label}
                </button>
              ))}
            </div>
          </nav>
        </>
      )}
    </div>
  );
};
