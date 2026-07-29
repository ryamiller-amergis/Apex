/**
 * FEAT-005 — Simplified Avatar Menu.
 * Actions: What's New, Profile, Sign Out. Theme/notification controls live on /profile.
 */
import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ThemeMode } from '../config/themes';
import { useCurrentProfile } from '../hooks/useProfile';
import {
  WalkthroughAnchorKeys,
  anchorTestIdProps,
} from '../../shared/walkthroughAnchors';
import { SharedAvatar } from './SharedAvatar';
import { WhatsNewIndicator } from './WhatsNewIndicator';
import styles from './UserMenu.module.css';

export interface UserMenuProps {
  onOpenChangelog: () => void;
  /** Retained for AppHeader / shell prop compatibility; not rendered in the menu. */
  onThemeChange: (theme: ThemeMode) => void;
  onLogout: () => void;
  /** Retained for AppHeader / shell prop compatibility; not rendered in the menu. */
  theme: ThemeMode;
  user: {
    name: string;
    email?: string;
  } | null;
  hasUnreadChangelog: boolean;
}

type MenuActionId = 'whats-new' | 'profile' | 'sign-out';

const MENU_ACTIONS: MenuActionId[] = ['whats-new', 'profile', 'sign-out'];

export const UserMenu: React.FC<UserMenuProps> = ({
  onOpenChangelog,
  onThemeChange: _onThemeChange,
  onLogout,
  theme: _theme,
  user,
  hasUnreadChangelog,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const { data: profile } = useCurrentProfile();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusRef = useRef(false);

  const userDisplayName =
    profile?.displayName?.trim() ||
    user?.name?.trim() ||
    user?.email ||
    'User';
  const userEmail = profile?.email ?? user?.email ?? null;
  const avatarOid = profile?.userOid?.trim() || '';
  const avatarVersion = profile?.avatar?.version ?? null;

  const closeMenu = (restoreFocus: boolean) => {
    restoreFocusRef.current = restoreFocus;
    setIsOpen(false);
  };

  useEffect(() => {
    if (isOpen) {
      itemRefs.current[0]?.focus();
      return;
    }
    if (restoreFocusRef.current) {
      triggerRef.current?.focus();
      restoreFocusRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu(false);
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const focusItem = (index: number) => {
    const count = MENU_ACTIONS.length;
    const next = ((index % count) + count) % count;
    itemRefs.current[next]?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((el) => el === document.activeElement);

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        focusItem(currentIndex < 0 ? 0 : currentIndex + 1);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        focusItem(currentIndex < 0 ? MENU_ACTIONS.length - 1 : currentIndex - 1);
        break;
      }
      case 'Home': {
        event.preventDefault();
        focusItem(0);
        break;
      }
      case 'End': {
        event.preventDefault();
        focusItem(MENU_ACTIONS.length - 1);
        break;
      }
      case 'Escape': {
        event.preventDefault();
        closeMenu(true);
        break;
      }
      case 'Tab': {
        event.preventDefault();
        if (event.shiftKey) {
          focusItem(currentIndex < 0 ? MENU_ACTIONS.length - 1 : currentIndex - 1);
        } else {
          focusItem(currentIndex < 0 ? 0 : currentIndex + 1);
        }
        break;
      }
      default:
        break;
    }
  };

  const handleWhatsNew = () => {
    closeMenu(false);
    onOpenChangelog();
  };

  const handleProfile = () => {
    closeMenu(false);
    navigate('/profile');
  };

  const handleSignOut = () => {
    closeMenu(false);
    onLogout();
  };

  return (
    <div className={styles['user-menu']} ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles['user-menu-trigger']} ${isOpen ? styles['user-menu-trigger-open'] : ''}`}
        onClick={() => (isOpen ? closeMenu(false) : setIsOpen(true))}
        title="User menu"
        aria-label="User menu"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        {...anchorTestIdProps(WalkthroughAnchorKeys.USER_MENU_TRIGGER)}
      >
        <SharedAvatar
          oid={avatarOid}
          displayName={userDisplayName}
          avatarVersion={avatarVersion}
          size="sm"
          decorative
        />
        <span className={styles['user-chevron']} aria-hidden="true">
          <svg viewBox="0 0 12 12" fill="none">
            <path d="M3 4.5L6 7.5l3-3" />
          </svg>
        </span>
        {hasUnreadChangelog && (
          <WhatsNewIndicator unread placement="avatar" announce />
        )}
        {hasUnreadChangelog && (
          <span
            className={styles['user-menu-badge']}
            data-testid="user-menu-unread-badge"
            aria-hidden="true"
          />
        )}
      </button>

      {isOpen && (
        <div
          className={styles['user-menu-dropdown']}
          role="menu"
          tabIndex={0}
          aria-label="User menu"
          data-testid="user-menu"
          onKeyDown={handleMenuKeyDown}
        >
          <div className={styles['user-menu-header']}>
            <SharedAvatar
              oid={avatarOid}
              displayName={userDisplayName}
              avatarVersion={avatarVersion}
              size="sm"
              decorative
            />
            <div>
              <div className={styles['user-menu-header-title']}>{userDisplayName}</div>
              <div className={styles['user-menu-header-subtitle']}>
                {userEmail ?? 'Application settings'}
              </div>
            </div>
          </div>

          <button
            ref={(el) => {
              itemRefs.current[0] = el;
            }}
            type="button"
            role="menuitem"
            className={styles['user-menu-item']}
            data-testid="user-menu-whats-new"
            onClick={handleWhatsNew}
          >
            <span className={styles['menu-item-icon']} aria-hidden="true">
              <svg viewBox="0 0 18 18" fill="none">
                <path d="M9 2.25l1.2 3.3 3.3 1.2-3.3 1.2L9 11.25l-1.2-3.3-3.3-1.2 3.3-1.2L9 2.25z" />
                <path d="M13 11l.6 1.6 1.65.65-1.65.6L13 15.5l-.6-1.65-1.65-.6 1.65-.65L13 11z" />
              </svg>
            </span>
            <span className={styles['menu-item-text']}>What's New</span>
            {hasUnreadChangelog && (
              <>
                <WhatsNewIndicator unread placement="menu" />
                <span className={styles['menu-item-badge']} aria-hidden="true">
                  NEW
                </span>
                <span className={styles['sr-only']}>Unread release notes available</span>
              </>
            )}
          </button>

          <button
            ref={(el) => {
              itemRefs.current[1] = el;
            }}
            type="button"
            role="menuitem"
            className={styles['user-menu-item']}
            data-testid="user-menu-profile"
            onClick={handleProfile}
          >
            <span className={styles['menu-item-icon']} aria-hidden="true">
              <svg viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="7" r="3" />
                <path d="M4 14.5c1.2-2 2.8-3 5-3s3.8 1 5 3" />
              </svg>
            </span>
            <span className={styles['menu-item-text']}>Profile</span>
          </button>

          <div
            className={styles['user-menu-divider']}
            data-testid="user-menu-sign-out-separator"
            role="separator"
          />

          <button
            ref={(el) => {
              itemRefs.current[2] = el;
            }}
            type="button"
            role="menuitem"
            className={`${styles['user-menu-item']} ${styles['user-menu-item-danger']}`}
            data-testid="user-menu-sign-out"
            onClick={handleSignOut}
          >
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

export default UserMenu;
