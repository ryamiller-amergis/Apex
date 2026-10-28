import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type {
  CreateUserQuickLinkInput,
  ImportQuickLinksResult,
  ProjectQuickLink,
  QuickLinkScope,
  UserQuickLink,
} from '../../shared/types/projectQuickLinks';
import {
  categoriesOf,
  useCreateMyQuickLink,
  useCreateProjectQuickLink,
  useDeleteMyQuickLink,
  useDeleteProjectQuickLink,
  useMyQuickLinks,
  useProjectQuickLinks,
  useUpdateMyQuickLink,
  useUpdateProjectQuickLink,
} from '../hooks/useProjectQuickLinks';
import { BookmarkImportModal } from './BookmarkImportModal';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { CategoryHeading, QuickLinkFavicon, categoryToneClass, hostnameOf } from './QuickLinkCategory';
import { QuickLinkEditModal, type QuickLinkEditValues } from './QuickLinkEditModal';
import styles from './QuickLinksMenu.module.css';

const MANAGE_LINKS_PATH = '/admin/project-settings#quick-links';
const TOAST_DURATION_MS = 6000;

type AnyQuickLink = ProjectQuickLink | UserQuickLink;

type LinkTarget =
  | { scope: 'project'; link: ProjectQuickLink }
  | { scope: 'personal'; link: UserQuickLink };

type DialogState =
  | { kind: 'add' }
  | { kind: 'edit'; target: LinkTarget }
  | { kind: 'delete'; target: LinkTarget }
  | { kind: 'import' };

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

function sectionName(scope: QuickLinkScope): string {
  switch (scope) {
    case 'personal':
      return 'My links';
    case 'project':
      return 'Project links';
    default: {
      const unhandled: never = scope;
      return unhandled;
    }
  }
}

export function describeImportResult(result: ImportQuickLinksResult, scope: QuickLinkScope): string {
  const parts = [`Imported ${result.created} link${result.created === 1 ? '' : 's'} to ${sectionName(scope)}`];
  if (result.skippedDuplicates > 0) parts.push(`${result.skippedDuplicates} already saved`);
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} not imported`);
  return parts.join(' · ');
}

const svgProps = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const LinkIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M8.5 11.5a3.5 3.5 0 005 0l2.5-2.5a3.5 3.5 0 00-5-5l-1 1" />
    <path d="M11.5 8.5a3.5 3.5 0 00-5 0L4 11a3.5 3.5 0 005 5l1-1" />
  </svg>
);

const ExternalIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M11 4h5v5" />
    <path d="M16 4l-7 7" />
    <path d="M14 11.5V15a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h3.5" />
  </svg>
);

const PencilIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M13.5 3.5l3 3L7 16H4v-3z" />
  </svg>
);

const TrashIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M4 6h12" />
    <path d="M8 6V4h4v2" />
    <path d="M6 6l1 10h6l1-10" />
  </svg>
);

const PlusIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M10 4v12M4 10h12" />
  </svg>
);

const ImportIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <path d="M10 3v9" />
    <path d="M6.5 8.5L10 12l3.5-3.5" />
    <path d="M4 14v2h12v-2" />
  </svg>
);

const GearIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg {...svgProps} className={className}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </svg>
);

interface QuickLinksMenuBodyProps {
  project: string;
  canManage: boolean;
  canOpenSettings: boolean;
  canAddPersonal: boolean;
  testId: string;
}

const QuickLinksMenuBody: React.FC<QuickLinksMenuBodyProps> = ({
  project,
  canManage,
  canOpenSettings,
  canAddPersonal,
  testId,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const { data: projectLinks = [] } = useProjectQuickLinks(project);
  const { data: myLinks = [] } = useMyQuickLinks(project, canAddPersonal);
  const createMyLink = useCreateMyQuickLink(project);
  const updateMyLink = useUpdateMyQuickLink(project);
  const deleteMyLink = useDeleteMyQuickLink(project);
  const createProjectLink = useCreateProjectQuickLink(project);
  const updateProjectLink = useUpdateProjectQuickLink(project);
  const deleteProjectLink = useDeleteProjectQuickLink(project);

  const projectGroups = useMemo(() => groupByCategory(projectLinks), [projectLinks]);
  const myGroups = useMemo(() => groupByCategory(myLinks), [myLinks]);
  const projectCategories = useMemo(() => categoriesOf(projectLinks), [projectLinks]);
  const personalCategories = useMemo(() => categoriesOf(myLinks), [myLinks]);

  const menuItems = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
    [],
  );

  const close = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const closeDialog = useCallback(() => {
    setSaveError(null);
    setDialog(null);
    triggerRef.current?.focus();
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

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const navigate = useNavigate();

  const openDialog = (next: DialogState) => {
    setIsOpen(false);
    setSaveError(null);
    setDialog(next);
  };

  const openSettings = () => {
    close(false);
    navigate(MANAGE_LINKS_PATH);
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

  const createIn = async (scope: QuickLinkScope, input: CreateUserQuickLinkInput): Promise<void> => {
    switch (scope) {
      case 'personal':
        await createMyLink.mutateAsync(input);
        return;
      case 'project':
        await createProjectLink.mutateAsync(input);
        return;
      default: {
        const unhandled: never = scope;
        throw new Error(`Unknown scope ${String(unhandled)}`);
      }
    }
  };

  const deleteTarget = async (target: LinkTarget): Promise<void> => {
    if (target.scope === 'project') await deleteProjectLink.mutateAsync({ id: target.link.id });
    else await deleteMyLink.mutateAsync({ id: target.link.id });
  };

  const saveLink = async (values: QuickLinkEditValues) => {
    const input = { label: values.label, url: values.url, category: values.category || null };
    setSaving(true);
    setSaveError(null);
    try {
      if (dialog?.kind === 'edit') {
        const { target } = dialog;
        if (target.scope !== values.scope) {
          await createIn(values.scope, input);
          await deleteTarget(target);
        } else if (target.scope === 'project') {
          await updateProjectLink.mutateAsync({ id: target.link.id, input });
        } else {
          await updateMyLink.mutateAsync({ id: target.link.id, input });
        }
      } else {
        await createIn(values.scope, input);
      }
      closeDialog();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the link');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async (target: LinkTarget) => {
    try {
      await deleteTarget(target);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not delete the link');
    }
    closeDialog();
  };

  const renderDialog = (current: DialogState): React.ReactNode => {
    switch (current.kind) {
      case 'add':
      case 'edit':
        return (
          <QuickLinkEditModal
            project={project}
            initial={
              current.kind === 'edit'
                ? {
                    label: current.target.link.label,
                    url: current.target.link.url,
                    category: current.target.link.category ?? '',
                    scope: current.target.scope,
                  }
                : undefined
            }
            canShare={canManage}
            personalCategories={personalCategories}
            projectCategories={projectCategories}
            isPending={saving}
            serverError={saveError}
            onSubmit={(values) => void saveLink(values)}
            onCancel={closeDialog}
            data-testid="quick-links-edit-modal"
          />
        );
      case 'delete':
        return (
          <ConfirmDeleteModal
            title={current.target.scope === 'project' ? 'Delete shared link' : 'Delete my link'}
            itemName={current.target.link.label}
            description={
              current.target.scope === 'project'
                ? `This removes it for everyone in ${project}. Delete`
                : undefined
            }
            isPending={deleteMyLink.isPending || deleteProjectLink.isPending}
            onConfirm={() => void confirmDelete(current.target)}
            onCancel={closeDialog}
            data-testid="quick-links-delete-modal"
          />
        );
      case 'import':
        return (
          <BookmarkImportModal
            project={project}
            canShare={canManage}
            existingPersonalCount={myLinks.length}
            existingProjectCount={projectLinks.length}
            personalCategories={personalCategories}
            projectCategories={projectCategories}
            onCancel={closeDialog}
            onImported={(result, scope) => {
              setToast(describeImportResult(result, scope));
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

  const renderRow = (target: LinkTarget, canEdit: boolean) => {
    const { link } = target;
    const ids =
      target.scope === 'project'
        ? { item: `quick-links-menu-item-${link.id}`, edit: `quick-links-menu-edit-${link.id}`, del: `quick-links-menu-delete-${link.id}` }
        : { item: `quick-links-menu-my-item-${link.id}`, edit: `quick-links-menu-my-edit-${link.id}`, del: `quick-links-menu-my-delete-${link.id}` };
    const host = hostnameOf(link.url);
    return (
      <div key={link.id} className={`${styles.row} ${canEdit ? styles.rowEditable : ''}`}>
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          role="menuitem"
          tabIndex={-1}
          className={styles.rowLink}
          title={link.url}
          aria-label={`${link.label} (${host}, opens in a new tab)`}
          onClick={() => close(false)}
          {...{ 'data-testid': ids.item }}
        >
          <QuickLinkFavicon url={link.url} label={link.label} category={link.category} />
          <span className={styles.rowText}>
            <span className={styles.rowLabel}>{link.label}</span>
            <span className={styles.rowHost}>{host}</span>
          </span>
          <ExternalIcon className={styles.rowExternal} />
        </a>
        {canEdit && (
          <div className={styles.rowActions}>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.rowAction}
              aria-label={`Edit ${link.label}`}
              title="Edit link"
              onClick={() => openDialog({ kind: 'edit', target })}
              {...{ 'data-testid': ids.edit }}
            >
              <PencilIcon className={styles.actionIcon} />
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`${styles.rowAction} ${styles.rowActionDanger}`}
              aria-label={`Delete ${link.label}`}
              title="Delete link"
              onClick={() => openDialog({ kind: 'delete', target })}
              {...{ 'data-testid': ids.del }}
            >
              <TrashIcon className={styles.actionIcon} />
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderCategories = <T extends AnyQuickLink>(
    groups: QuickLinkGroup<T>[],
    toTarget: (link: T) => LinkTarget,
    canEdit: boolean,
    keyPrefix: string,
  ) =>
    groups.map((group) => (
      <div
        key={`${keyPrefix}-${group.category ?? '__other__'}`}
        role="group"
        aria-label={group.category ?? 'Other'}
        className={`${styles.category} ${categoryToneClass(group.category)}`}
      >
        <CategoryHeading category={group.category} />
        {group.links.map((link) => renderRow(toTarget(link), canEdit))}
      </div>
    ));

  const showProjectSection = projectLinks.length > 0 || canManage;
  const showMySection = myLinks.length > 0 || canAddPersonal;
  const showFooter = canAddPersonal || canOpenSettings;

  if (!showProjectSection && !showMySection) return null;

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
          {showProjectSection && (
            <div
              role="group"
              aria-labelledby="quick-links-section-project"
              className={styles.section}
              {...{ 'data-testid': 'quick-links-menu-project' }}
            >
              <div className={styles.sectionHeader}>
                <span id="quick-links-section-project" className={styles.sectionTitle}>Project links</span>
                <span className={styles.sectionHint}>Shared with everyone in {project}</span>
              </div>
              {projectLinks.length === 0 ? (
                <p className={styles.empty} {...{ 'data-testid': 'quick-links-menu-project-empty' }}>
                  No shared links yet
                  {canOpenSettings ? (
                    <>
                      {' — '}
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        className={styles.inlineAction}
                        onClick={openSettings}
                        {...{ 'data-testid': 'quick-links-menu-project-empty-manage' }}
                      >
                        Manage links…
                      </button>
                    </>
                  ) : (
                    <> — use Add link and choose &ldquo;Everyone in {project}&rdquo;.</>
                  )}
                </p>
              ) : (
                renderCategories(projectGroups, (link) => ({ scope: 'project', link }), canManage, 'project')
              )}
            </div>
          )}

          {showMySection && (
            <div
              role="group"
              aria-labelledby="quick-links-section-mine"
              className={styles.section}
              {...{ 'data-testid': 'quick-links-menu-mine' }}
            >
              <div className={styles.sectionHeader}>
                <span id="quick-links-section-mine" className={styles.sectionTitle}>My links</span>
                <span className={styles.sectionHint}>Only visible to you</span>
              </div>
              {myLinks.length === 0 ? (
                <p className={styles.empty} {...{ 'data-testid': 'quick-links-menu-mine-empty' }}>
                  No personal links yet. Add one or import your bookmarks.
                </p>
              ) : (
                renderCategories(myGroups, (link) => ({ scope: 'personal', link }), true, 'mine')
              )}
            </div>
          )}

          {showFooter && (
            <div className={styles.footer} {...{ 'data-testid': 'quick-links-menu-footer' }}>
              {canAddPersonal && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={styles.footerButton}
                    onClick={() => openDialog({ kind: 'add' })}
                    {...{ 'data-testid': 'quick-links-menu-add' }}
                  >
                    <PlusIcon className={styles.actionIcon} />
                    Add link
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={styles.footerButton}
                    onClick={() => openDialog({ kind: 'import' })}
                    {...{ 'data-testid': 'quick-links-menu-import' }}
                  >
                    <ImportIcon className={styles.actionIcon} />
                    Import bookmarks
                  </button>
                </>
              )}
              {canOpenSettings && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={styles.footerButton}
                  onClick={openSettings}
                  {...{ 'data-testid': 'quick-links-menu-manage' }}
                >
                  <GearIcon className={styles.actionIcon} />
                  Manage links…
                </button>
              )}
            </div>
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
  /** quick-links:manage — edit shared links and choose "Everyone in <project>" when saving. */
  canManage?: boolean;
  /** Can open Project Admin → Project Settings (needs admin:roles too). */
  canOpenSettings?: boolean;
  /** quick-links:personal — add, edit, delete, and import personal links. */
  canAddPersonal?: boolean;
  'data-testid'?: string;
}

export const QuickLinksMenu: React.FC<QuickLinksMenuProps> = ({
  project,
  hidden = false,
  canManage = false,
  canOpenSettings = false,
  canAddPersonal = false,
  'data-testid': testId = 'quick-links-menu',
}) => {
  if (!project || hidden) return null;
  return (
    <QuickLinksMenuBody
      key={project}
      project={project}
      canManage={canManage}
      canOpenSettings={canOpenSettings}
      canAddPersonal={canAddPersonal}
      testId={testId}
    />
  );
};

export default QuickLinksMenu;
