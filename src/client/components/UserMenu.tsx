import React, { useState, useRef, useEffect } from 'react';
import styles from './UserMenu.module.css';

interface UserMenuProps {
  onOpenChangelog: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  theme: 'light' | 'dark';
  hasUnreadChangelog: boolean;
}

export const UserMenu: React.FC<UserMenuProps> = ({
  onOpenChangelog,
  onToggleTheme,
  onLogout,
  theme,
  hasUnreadChangelog,
}) => {
  const [isOpen, setIsOpen] = useState(false);
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
  const handleThemeClick = () => { onToggleTheme(); setIsOpen(false); };
  const handleLogoutClick = () => { onLogout(); setIsOpen(false); };

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
            <span className={styles['user-menu-header-mark']}>ASM</span>
            <div>
              <div className={styles['user-menu-header-title']}>Workspace</div>
              <div className={styles['user-menu-header-subtitle']}>Application settings</div>
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

          <button className={styles['user-menu-item']} onClick={handleThemeClick}>
            <span className={styles['menu-item-icon']} aria-hidden="true">
              {theme === 'light' ? (
                <svg viewBox="0 0 18 18" fill="none">
                  <path d="M14.25 11.35A5.75 5.75 0 016.65 3.75a6 6 0 107.6 7.6z" />
                </svg>
              ) : (
                <svg viewBox="0 0 18 18" fill="none">
                  <circle cx="9" cy="9" r="3.25" />
                  <path d="M9 1.75v1.5M9 14.75v1.5M1.75 9h1.5M14.75 9h1.5M3.9 3.9l1.05 1.05M13.05 13.05l1.05 1.05M14.1 3.9l-1.05 1.05M4.95 13.05L3.9 14.1" />
                </svg>
              )}
            </span>
            <span className={styles['menu-item-text']}>
              {theme === 'light' ? 'Dark Mode' : 'Light Mode'}
            </span>
          </button>

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
