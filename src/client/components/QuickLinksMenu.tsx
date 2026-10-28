import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type {
  ImportUserQuickLinksResult,
  ProjectQuickLink,
  UserQuickLink,
} from '../../shared/types/projectQuickLinks';
import {
  useCreateMyQuickLink,
  useDeleteMyQuickLink,
  useMyQuickLinks,
  useProjectQuickLinks,
  useUpdateMyQuickLink,
} from '../hooks/useProjectQuickLinks';
import { BookmarkImportModal } from './BookmarkImportModal';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { PersonalQuickLinkModal, type PersonalQuickLinkFormValues } from './PersonalQuickLinkModal';
import styles from './QuickLinksMenu.module.css';

const MANAGE_LINKS_PATH = '/admin/project-settings#quick-links';
const TOAST_DURATION_MS = 6000;

type AnyQuickLink = ProjectQuickLink | UserQuickLink;

interface QuickLinkGroup<T extends AnyQuickLink> {
  category: string | null;
  links: T[];
}

function groupByCategory<T extends AnyQuickLink>(links: T[]): QuickLinkGroup<T>[] {
  const groups: QuickLinkGroup<T>[] = [];
  for (const link of links) {
    const category = link.category ?? null;
    const last = groups[groups.length - 1];
    if (last && last.category === category) last.links.push(link);
    else groups.push({ category, links: [link] });
  }
  return groups;
}

export function describeImportResult(result: ImportUserQuickLinksResult): string {
  const parts = [`Imported ${result.created} link${result.created === 1 ? '' : 's'}`];
  if (result.skippedDuplicates > 0) parts.push(`${result.skippedDuplicates} already saved`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} not imported`);
  return parts.join(' · ');
}

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; link: UserQuickLink }
  | { kind: 'delete'; link: UserQuickLink }
  | { kind: 'import' };

const LinkIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
    <path d="M8.5 11.5a3.5 3.5 0 005 0l2.5-2.5a3.5 3.5 0 00-5-5l-1 1" />
    <path d="M11.5 8.5a3.5 3.5 0 00-5 0L4 11a3.5 3.5 0 005 5l1-1" />
  </svg>
);

interface QuickLinksMenuBodyProps {
  project: string;
  canManage: boolean;
  canAddPersonal: boolean;
  testId: string;
}

const QuickLinksMenuBody: React.FC<QuickLinksMenuBodyProps> = ({
  project,
  canManage,
  canAddPersonal,
  testId,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data: projectLinks = [] } = useProjectQuickLinks(project);
  const { data: myLinks = [] } = useMyQuickLinks(project, canAddPersonal);
  const createMyLink = useCreateMyQuickLink(project);
  const updateMyLink = useUpdateMyQuickLink(project);
  const deleteMyLink = useDeleteMyQuickLink(project);

  const projectGroups = useMemo(() => groupByCategory(projectLinks), [projectLinks]);
  const myGroups = useMemo(() => groupByCategory(myLinks), [myLinks]);
  const myCategories = useMemo(
    () => Array.from(new Set(myLinks.map((l) => l.category).filter((c): c is string => Boolean(c)))),
    [myLinks],
  );
  const showProjectHeadings = projectGroups.length > 1 || projectGroups[0]?.category != null;

  const menuItems = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeDialog = useCallback(() => {
    createMyLink.reset();
    updateMyLink.reset();
    setDialog(null);
    triggerRef.current?.focus();
  }, [createMyLink, updateMyLink]);

  useEffect(() => {
    if (!isOpen) return;
    menuItems()[0]?.focus();
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, close, menuItems]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigate = useNavigate();

  const openDialog = (next: DialogState) => {
    setIsOpen(false);
    setDialog(next);
  };

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

  const savePersonalLink = (values: PersonalQuickLinkFormValues) => {
    const input = { label: values.label, url: values.url, category: values.category || null };
    if (dialog?.kind === 'edit') {
      updateMyLink.mutate({ id: dialog.link.id, input }, { onSuccess: closeDialog });
    } else {
      createMyLink.mutate(input, { onSuccess: closeDialog });
    }
  };

  const renderDialog = (current: DialogState): React.ReactNode => {
    switch (current.kind) {
      case 'add':
      case 'edit':
        return (
          <PersonalQuickLinkModal
            link={current.kind === 'edit' ? current.link : null}
            categories={myCategories}
            isPending={createMyLink.isPending || updateMyLink.isPending}
            serverError={(createMyLink.error ?? updateMyLink.error)?.message ?? null}
            onSubmit={savePersonalLink}
            onCancel={closeDialog}
            data-testid="quick-links-personal-modal"
          />
        );
      case 'delete':
        return (
          <ConfirmDeleteModal
            title="Delete my link"
            itemName={current.link.label}
            isPending={deleteMyLink.isPending}
            onConfirm={() =>
              deleteMyLink.mutate(
                { id: current.link.id },
                { onSuccess: closeDialog, onError: (err) => { setToast(err.message); closeDialog(); } },
              )
            }
            onCancel={closeDialog}
            data-testid="quick-links-personal-delete-modal"
          />
        );
      case 'import':
        return (
          <BookmarkImportModal
            project={project}
            existingCount={myLinks.length}
            onCancel={closeDialog}
            onImported={(result) => {
              setToast(describeImportResult(result));
              closeDialog();
            }}
            data-testid="quick-links-import-modal"
          />
        );
      default: {
        const unhandled: never = current;
        return unhandled;
      }
    }
  };

  if (projectLinks.length === 0 && myLinks.length === 0 && !canAddPersonal) return null;

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
          {projectGroups.map((group) => (
            <div
              key={group.category ?? '__uncategorized__'}
              role="group"
              aria-label={group.category ?? 'Other links'}
              className={styles.group}
            >
              {showProjectHeadings && (
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

          {myLinks.length > 0 && (
            <div role="group" aria-label="My links" className={styles.group} {...{ 'data-testid': 'quick-links-menu-mine' }}>
              {projectLinks.length > 0 && <div className={styles.divider} role="separator" />}
              <div className={styles.sectionHeading} aria-hidden="true">My links</div>
              {myGroups.map((group) => (
                <div key={group.category ?? '__mine_uncategorized__'} role="group" aria-label={group.category ?? 'My other links'}>
                  {group.category && (
                    <div className={styles.groupHeading} aria-hidden="true">{group.category}</div>
                  )}
                  {group.links.map((link) => (
                    <div key={link.id} className={styles.personalRow}>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        role="menuitem"
                        tabIndex={-1}
                        className={`${styles.item} ${styles.personalLink}`}
                        onClick={() => close(false)}
                        {...{ 'data-testid': `quick-links-menu-my-item-${link.id}` }}
                      >
                        <span className={styles.itemLabel}>{link.label}</span>
                        <span className={styles.external} aria-hidden="true">↗</span>
                      </a>
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={styles.rowAction}
                        aria-label={`Edit ${link.label}`}
                        title="Edit"
                        onClick={() => openDialog({ kind: 'edit', link })}
                        {...{ 'data-testid': `quick-links-menu-my-edit-${link.id}` }}
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={styles.rowAction}
                        aria-label={`Delete ${link.label}`}
                        title="Delete"
                        onClick={() => openDialog({ kind: 'delete', link })}
                        {...{ 'data-testid': `quick-links-menu-my-delete-${link.id}` }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {(canAddPersonal || canManage) && (projectLinks.length > 0 || myLinks.length > 0) && (
            <div className={styles.divider} role="separator" />
          )}

          {canAddPersonal && (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.item} ${styles.manageItem}`}
                onClick={() => openDialog({ kind: 'add' })}
                {...{ 'data-testid': 'quick-links-menu-add' }}
              >
                Add link
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`${styles.item} ${styles.manageItem}`}
                onClick={() => openDialog({ kind: 'import' })}
                {...{ 'data-testid': 'quick-links-menu-import' }}
              >
                Import bookmarks
              </button>
            </>
          )}

          {canManage && (
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
          )}
        </div>
      )}

      {dialog && createPortal(renderDialog(dialog), document.body)}

      {toast && createPortal(
        <div className={styles.toast} role="status" aria-live="polite" {...{ 'data-testid': 'quick-links-toast' }}>
          <span>{toast}</span>
          <button
            type="button"
            className={styles.toastDismiss}
            aria-label="Dismiss"
            onClick={() => setToast(null)}
            {...{ 'data-testid': 'quick-links-toast-dismiss' }}
          >
            ×
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
};

interface QuickLinksMenuProps {
  project?: string | null;
  hidden?: boolean;
  canManage?: boolean;
  canAddPersonal?: boolean;
  'data-testid'?: string;
}

export const QuickLinksMenu: React.FC<QuickLinksMenuProps> = ({
  project,
  hidden = false,
  canManage = false,
  canAddPersonal = false,
  'data-testid': testId = 'quick-links-menu',
}) => {
  if (!project || hidden) return null;
  return (
    <QuickLinksMenuBody
      key={project}
      project={project}
      canManage={canManage}
      canAddPersonal={canAddPersonal}
      testId={testId}
    />
  );
};

export default QuickLinksMenu;
