import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectQuickLink } from '../../shared/types/projectQuickLinks';
import { useProjectQuickLinks } from '../hooks/useProjectQuickLinks';
import styles from './QuickLinksMenu.module.css';

const MANAGE_LINKS_PATH = '/admin/project-settings#quick-links';

interface QuickLinkGroup {
  category: string | null;
  links: ProjectQuickLink[];
}

function groupByCategory(links: ProjectQuickLink[]): QuickLinkGroup[] {
  const groups: QuickLinkGroup[] = [];
  for (const link of links) {
    const category = link.category ?? null;
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.links.push(link);
    else groups.push({ category, links: [link] });
  }
  return groups;
}

const LinkIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M8.5 11.5a3.5 3.5 0 005 0l2.5-2.5a3.5 3.5 0 00-5-5l-1 1" />
    <path d="M11.5 8.5a3.5 3.5 0 00-5 0L4 11a3.5 3.5 0 005 5l1-1" />
  </svg>
);

interface QuickLinksMenuBodyProps {
  project: string;
  canManage: boolean;
  testId: string;
}

const QuickLinksMenuBody: React.FC<QuickLinksMenuBodyProps> = ({ project, canManage, testId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data: links = [] } = useProjectQuickLinks(project);

  const groups = useMemo(() => groupByCategory(links), [links]);
  const showGroupHeadings = groups.length > 1 || groups[0]?.category != null;

  const menuItems = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    menuItems()[0]?.focus();
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, close, menuItems]);

  const navigate = useNavigate();

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        items[(current + 1) % items.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
      default:
        break;
    }
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' && !isOpen) {
      e.preventDefault();
      setIsOpen(true);
    }
  };

  if (links.length === 0) return null;

  return (
    <div className={styles.wrapper} ref={wrapperRef} {...{ 'data-testid': testId }}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${isOpen ? styles.triggerOpen : ''}`}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleTriggerKeyDown}
        title="Quick links"
        aria-label={`Quick links for ${project}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'quick-links-menu-list' : undefined}
        {...{ 'data-testid': 'quick-links-menu-trigger' }}
      >
        <LinkIcon className={styles.icon} />
      </button>

      {isOpen && (
        <div
          ref={menuRef}
          id="quick-links-menu-list"
          className={styles.menu}
          role="menu"
          tabIndex={-1}
          aria-label={`Quick links for ${project}`}
          onKeyDown={handleMenuKeyDown}
          {...{ 'data-testid': 'quick-links-menu-list' }}
        >
          {groups.map((group) => (
            <div
              key={group.category ?? '__uncategorized__'}
              role="group"
              aria-label={group.category ?? 'Other links'}
              className={styles.group}
            >
              {showGroupHeadings && (
                <div className={styles.groupHeading} aria-hidden="true">
                  {group.category ?? 'Other'}
                </div>
              )}
              {group.links.map((link) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  role="menuitem"
                  tabIndex={-1}
                  className={styles.item}
                  onClick={() => close(false)}
                  {...{ 'data-testid': `quick-links-menu-item-${link.id}` }}
                >
                  <span className={styles.itemLabel}>{link.label}</span>
                  <span className={styles.external} aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
          ))}

          {canManage && (
            <>
              <div className={styles.divider} role="separator" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.item} ${styles.manageItem}`}
                onClick={() => {
                  close(false);
                  navigate(MANAGE_LINKS_PATH);
                }}
                {...{ 'data-testid': 'quick-links-menu-manage' }}
              >
                Manage links…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};

interface QuickLinksMenuProps {
  project?: string | null;
  hidden?: boolean;
  canManage?: boolean;
  'data-testid'?: string;
}

export const QuickLinksMenu: React.FC<QuickLinksMenuProps> = ({
  project,
  hidden = false,
  canManage = false,
  'data-testid': testId = 'quick-links-menu',
}) => {
  if (!project || hidden) return null;
  return <QuickLinksMenuBody key={project} project={project} canManage={canManage} testId={testId} />;
};

export default QuickLinksMenu;
