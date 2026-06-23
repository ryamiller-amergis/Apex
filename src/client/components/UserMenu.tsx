import React, { useState, useRef, useEffect } from 'react';
import { NotificationPreferences } from './NotificationPreferences';
import type { ThemeMode } from '../hooks/useAppShell';
import styles from './UserMenu.module.css';

interface UserMenuProps {
  onOpenChangelog: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  onLogout: () => void;
  theme: ThemeMode;
  user: {
    name: string;
    email?: string;
  } | null;
  hasUnreadChangelog: boolean;
}

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'amergis', label: 'Amergis' },
];

function getUserInitials(user: UserMenuProps['user']): string {
  const displayName = user?.name?.trim();
  if (displayName) {
    const parts = displayName.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
    }
    return displayName.slice(0, 2).toUpperCase();
  }

  const emailPrefix = user?.email?.split('@')[0]?.trim();
  return emailPrefix ? emailPrefix.slice(0, 2).toUpperCase() : '??';
}

export const UserMenu: React.FC<UserMenuProps> = ({
  onOpenChangelog,
  onThemeChange,
  onLogout,
  theme,
  user,
  hasUnreadChangelog,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [showNotifPrefs, setShowNotifPrefs] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleChangelogClick = () => { onOpenChangelog(); setIsOpen(false); };
  const handleThemeSelect = (nextTheme: ThemeMode) => { onThemeChange(nextTheme); };
  const handleLogoutClick = () => { onLogout(); setIsOpen(false); };
  const userInitials = getUserInitials(user);
  const userDisplayName = user?.name?.trim() || user?.email || 'User';

  return (
    <div className={styles['user-menu']} ref={menuRef}>
      <button
        className={`${styles['user-menu-trigger']} ${isOpen ? styles['user-menu-trigger-open'] : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="User menu"
        aria-label="User menu"
        aria-expanded={isOpen}
      >
        <span className={styles['user-avatar']} aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <path d="M10 10.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z" />
            <path d="M3.75 17a6.25 6.25 0 0112.5 0" />
          </svg>
        </span>
        <span className={styles['user-chevron']} aria-hidden="true">
          <svg viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5l3-3" />
          </svg>
        </span>
        {hasUnreadChangelog && <span className={styles['user-menu-badge']}></span>}
      </button>

      {isOpen && (
        <div className={styles['user-menu-dropdown']}>
          <div className={styles['user-menu-header']}>
            <span className={styles['user-menu-header-mark']}>{userInitials}</span>
            <div>
              <div className={styles['user-menu-header-title']}>{userDisplayName}</div>
              <div className={styles['user-menu-header-subtitle']}>{user?.email ?? 'Application settings'}</div>
            </div>
          </div>

          <button className={styles['user-menu-item']} onClick={handleChangelogClick}>
            <span className={styles['menu-item-icon']} aria-hidden="true">
              <svg viewBox="0 0 18 18" fill="none">
                <path d="M9 2.25l1.2 3.3 3.3 1.2-3.3 1.2L9 11.25l-1.2-3.3-3.3-1.2 3.3-1.2L9 2.25z" />
                <path d="M13 11l.6 1.6 1.65.65-1.65.6L13 15.5l-.6-1.65-1.65-.6 1.65-.65L13 11z" />
              </svg>
            </span>
            <span className={styles['menu-item-text']}>What's New</span>
            {hasUnreadChangelog && <span className={styles['menu-item-badge']}>NEW</span>}
          </button>

          <button className={styles['user-menu-item']} onClick={() => setShowNotifPrefs(!showNotifPrefs)}>
            <span className={styles['menu-item-icon']} aria-hidden="true">
              <svg viewBox="0 0 18 18" fill="none">
                <path d="M9 3a4 4 0 00-4 4c0 2.2-.65 3.75-1.3 4.6-.33.44-.02 1.1.53 1.1h9.54c.55 0 .86-.66.53-1.1C13.65 10.75 13 9.2 13 7a4 4 0 00-4-4z" />
                <path d="M7.25 13a1.75 1.75 0 103.5 0" />
              </svg>
            </span>
            <span className={styles['menu-item-text']}>Notification Settings</span>
          </button>

          {showNotifPrefs && (
            <div className={styles['user-menu-inline-panel']}>
              <NotificationPreferences />
            </div>
          )}

          <div className={styles['theme-section']}>
            <div className={styles['theme-section-header']}>
              <span className={styles['menu-item-icon']} aria-hidden="true">
                <svg viewBox="0 0 18 18" fill="none">
                  <circle cx="9" cy="9" r="3.25" />
                  <path d="M9 1.75v1.5M9 14.75v1.5M1.75 9h1.5M14.75 9h1.5M3.9 3.9l1.05 1.05M13.05 13.05l1.05 1.05M14.1 3.9l-1.05 1.05M4.95 13.05L3.9 14.1" />
                </svg>
              </span>
              <div>
                <div className={styles['theme-section-title']}>Theme</div>
                <div className={styles['theme-section-subtitle']}>Choose your display mode</div>
              </div>
            </div>
            <div className={styles['theme-toggle']} role="radiogroup" aria-label="Theme">
              {themeOptions.map((option) => (
                <button
                  key={option.value}
                  className={`${styles['theme-toggle-option']} ${theme === option.value ? styles['theme-toggle-option-active'] : ''}`}
                  onClick={() => handleThemeSelect(option.value)}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className={styles['user-menu-divider']}></div>

          <button className={`${styles['user-menu-item']} ${styles['user-menu-item-danger']}`} onClick={handleLogoutClick}>
            <span className={styles['menu-item-icon']} aria-hidden="true">
              <svg viewBox="0 0 18 18" fill="none">
                <path d="M7 3.25H4.75A1.75 1.75 0 003 5v8a1.75 1.75 0 001.75 1.75H7" />
                <path d="M11.25 5.75L14.5 9l-3.25 3.25M14.25 9H7" />
              </svg>
            </span>
            <span className={styles['menu-item-text']}>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  );
};
