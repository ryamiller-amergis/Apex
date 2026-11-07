import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ProjectQuickLink } from '../../shared/types/projectQuickLinks';
import {
  categoriesOf,
  useCreateProjectQuickLink,
  useDeleteProjectQuickLink,
  useProjectQuickLinks,
  useReorderProjectQuickLinks,
  useUpdateProjectQuickLink,
} from '../hooks/useProjectQuickLinks';
import { useAppShell } from '../hooks/useAppShell';
import {
  quickLinkCategoryField,
  quickLinkLabelField,
  quickLinkUrlField,
} from '../utils/quickLinkForm';
import {
  groupQuickLinks,
  moveQuickLink,
  moveQuickLinkCategory,
  type DropPlacement,
} from '../utils/quickLinkOrder';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { CategoryPill, OTHER_CATEGORY_LABEL } from './QuickLinkCategory';
import { QuickLinkCategoryField } from './QuickLinkCategoryField';
import { DataGridFilterSelect, DataGridToolbar } from './DataGridToolbar';
import { NumberStepper } from './NumberStepper';
import gridStyles from './DataGrid.module.css';
import styles from './ProjectQuickLinksSettings.module.css';

export const QUICK_LINKS_SECTION_ID = 'quick-links';

const UNCATEGORIZED = '__none__';

const quickLinkSchema = z.object({
  label: quickLinkLabelField,
  url: quickLinkUrlField,
  category: quickLinkCategoryField,
  sortOrder: z.number().int().min(0),
});

type QuickLinkFormValues = z.infer<typeof quickLinkSchema>;

interface QuickLinkFormModalProps {
  link: ProjectQuickLink | null;
  /** Sort order a new link starts with, so it lands at the end. */
  newSortOrder: number;
  categories: string[];
  isPending: boolean;
  serverError: string | null;
  onSubmit: (values: QuickLinkFormValues) => void;
  onCancel: () => void;
  'data-testid'?: string;
}

const QuickLinkFormModal: React.FC<QuickLinkFormModalProps> = ({
  link,
  newSortOrder,
  categories,
  isPending,
  serverError,
  onSubmit,
  onCancel,
  'data-testid': testId = 'quick-link-form-modal',
}) => {
  const {
    register,
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<QuickLinkFormValues>({
    resolver: zodResolver(quickLinkSchema),
    defaultValues: {
      label: link?.label ?? '',
      url: link?.url ?? '',
      category: link?.category ?? '',
      sortOrder: link?.sortOrder ?? newSortOrder,
    },
  });

  useEffect(() => {
    setFocus('label');
  }, [setFocus]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-link-form-title"
      {...{ 'data-testid': testId }}
    >
      <form
        className={styles.card}
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        {...{ 'data-testid': 'quick-link-form' }}
      >
        <h2 className={styles.title} id="quick-link-form-title">
          {link ? 'Edit quick link' : 'Add quick link'}
        </h2>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="quick-link-label">Label</label>
          <input
            id="quick-link-label"
            className={styles.input}
            placeholder="e.g. MaxView Prod"
            aria-invalid={Boolean(errors.label)}
            {...register('label')}
            {...{ 'data-testid': 'quick-link-form-label' }}
          />
          {errors.label && <p className={styles.fieldError}>{errors.label.message}</p>}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="quick-link-url">URL</label>
          <input
            id="quick-link-url"
            className={styles.input}
            type="url"
            placeholder="https://"
            aria-invalid={Boolean(errors.url)}
            {...register('url')}
            {...{ 'data-testid': 'quick-link-form-url' }}
          />
          {errors.url && <p className={styles.fieldError}>{errors.url.message}</p>}
        </div>

        <div className={styles.row}>
          <Controller
            control={control}
            name="category"
            render={({ field }) => (
              <QuickLinkCategoryField
                id="quick-link-category"
                label="Category (optional)"
                value={field.value}
                onChange={field.onChange}
                options={categories}
                error={errors.category?.message}
                data-testid="quick-link-form-category"
              />
            )}
          />

          <div className={styles.field}>
            <label className={styles.label} htmlFor="quick-link-sort-order">Sort order</label>
            <Controller
              control={control}
              name="sortOrder"
              render={({ field }) => (
                <NumberStepper
                  id="quick-link-sort-order"
                  value={field.value}
                  onChange={field.onChange}
                  min={0}
                  max={100000}
                  aria-label="Sort order"
                  data-testid="quick-link-form-sort-order"
                />
              )}
            />
          </div>
        </div>

        {serverError && (
          <p className={styles.formError} role="alert" {...{ 'data-testid': 'quick-link-form-error' }}>
            {serverError}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={gridStyles.button}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'quick-link-form-cancel' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={gridStyles.buttonPrimary}
            disabled={isPending}
            {...{ 'data-testid': 'quick-link-form-save' }}
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
};

/** Swaps a link with its neighbour inside the same category and returns every id in display order. */
function moveWithinCategory(links: ProjectQuickLink[], id: string, direction: -1 | 1): string[] | null {
  const index = links.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const target = index + direction;
  if (target < 0 || target >= links.length) return null;
  if ((links[target].category ?? null) !== (links[index].category ?? null)) return null;
  const ids = links.map((l) => l.id);
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

/** Moves a whole category one place up or down and returns every id in display order. */
function moveCategory(links: ProjectQuickLink[], category: string | null, direction: -1 | 1): string[] | null {
  const groups = groupQuickLinks(links);
  const index = groups.findIndex((g) => g.category === category);
  const neighbour = groups[index + direction];
  if (index < 0 || !neighbour) return null;
  return moveQuickLinkCategory(links, category, neighbour.category, direction < 0 ? 'before' : 'after')?.ids ?? null;
}

/** Drops `dragId` before or after `target`; links only move within their own category. */
function dropLink(
  links: ProjectQuickLink[],
  dragId: string,
  target: ProjectQuickLink,
  placement: DropPlacement,
): string[] | null {
  const category = target.category ?? null;
  const siblings = links.filter((l) => (l.category ?? null) === category);
  const beforeId = placement === 'before'
    ? target.id
    : (siblings[siblings.findIndex((l) => l.id === target.id) + 1]?.id ?? null);
  return moveQuickLink(links, dragId, category, beforeId)?.ids ?? null;
}

/** What the user is dragging in the grid. */
type DragItem = { kind: 'link'; id: string; category: string | null } | { kind: 'category'; category: string | null };

interface DropHint {
  rowId: string;
  placement: DropPlacement;
}

function placementFor(e: React.DragEvent<HTMLElement>): DropPlacement {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function moveDirection(e: React.KeyboardEvent): -1 | 1 | null {
  if (!e.altKey) return null;
  if (e.key === 'ArrowUp') return -1;
  if (e.key === 'ArrowDown') return 1;
  return null;
}

type EditTarget = ProjectQuickLink | 'new' | null;
type DeleteTarget = ProjectQuickLink | null;

interface ProjectQuickLinksSettingsBodyProps {
  project: string;
}

const ProjectQuickLinksSettingsBody: React.FC<ProjectQuickLinksSettingsBodyProps> = ({ project }) => {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [editing, setEditing] = useState<EditTarget>(null);
  const [deleting, setDeleting] = useState<DeleteTarget>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const linksQuery = useProjectQuickLinks(project);
  const createLink = useCreateProjectQuickLink(project);
  const updateLink = useUpdateProjectQuickLink(project);
  const deleteLink = useDeleteProjectQuickLink(project);
  const reorderLinks = useReorderProjectQuickLinks(project);

  const links = useMemo(
    () => groupQuickLinks(linksQuery.data ?? []).flatMap((group) => group.links),
    [linksQuery.data],
  );
  const newSortOrder = useMemo(
    () => links.reduce((highest, link) => Math.max(highest, link.sortOrder), -1) + 1,
    [links],
  );

  const categories = useMemo(
    () => categoriesOf(links),
    [links],
  );

  const categoryOptions = useMemo(
    () => [
      ...categories.map((c) => ({ label: c, value: c })),
      ...(links.some((l) => !l.category) ? [{ label: OTHER_CATEGORY_LABEL, value: UNCATEGORIZED }] : []),
    ],
    [categories, links],
  );

  const filteredLinks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links.filter((link) => {
      if (categoryFilter === UNCATEGORIZED && link.category) return false;
      if (categoryFilter && categoryFilter !== UNCATEGORIZED && link.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        link.label.toLowerCase().includes(q) ||
        link.url.toLowerCase().includes(q) ||
        (link.category ?? '').toLowerCase().includes(q)
      );
    });
  }, [links, search, categoryFilter]);

  useEffect(() => {
    if (linksQuery.isLoading) return;
    if (window.location.hash === `#${QUICK_LINKS_SECTION_ID}`) {
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }
  }, [linksQuery.isLoading]);

  const saveError = (createLink.error ?? updateLink.error)?.message ?? null;
  const isSaving = createLink.isPending || updateLink.isPending;

  const closeForm = () => {
    createLink.reset();
    updateLink.reset();
    setEditing(null);
  };

  const handleSubmit = (values: QuickLinkFormValues) => {
    const input = {
      label: values.label,
      url: values.url,
      category: values.category || null,
      sortOrder: values.sortOrder,
    };
    if (editing && editing !== 'new') {
      updateLink.mutate({ id: editing.id, input }, { onSuccess: closeForm });
    } else {
      createLink.mutate(input, { onSuccess: closeForm });
    }
  };

  const saveOrder = (ids: string[] | null) => {
    if (!ids) return;
    setActionError(null);
    reorderLinks.mutate({ ids }, { onError: (err) => setActionError(err.message) });
  };
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);
  const hasFilter = Boolean(search.trim() || categoryFilter);
  const canReorder = !hasFilter && !reorderLinks.isPending;

  const endDrag = () => {
    setDrag(null);
    setDropHint(null);
  };

  const startDrag = (e: React.DragEvent<HTMLElement>, item: DragItem, label: string) => {
    e.stopPropagation();
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', label);
    }
    setDrag(item);
  };

  /** A link may land on a row of its own category; a category may land on any other category. */
  const acceptsDrop = (target: ProjectQuickLink): boolean => {
    if (!drag) return false;
    const category = target.category ?? null;
    return drag.kind === 'link' ? drag.category === category && drag.id !== target.id : drag.category !== category;
  };

  const rowDragHandlers = (link: ProjectQuickLink) => ({
    draggable: canReorder,
    onDragStart: (e: React.DragEvent<HTMLTableRowElement>) =>
      startDrag(e, { kind: 'link', id: link.id, category: link.category ?? null }, link.label),
    onDragEnd: endDrag,
    onDragOver: (e: React.DragEvent<HTMLTableRowElement>) => {
      if (!acceptsDrop(link)) return;
      e.preventDefault();
      const placement = placementFor(e);
      if (dropHint?.rowId !== link.id || dropHint.placement !== placement) setDropHint({ rowId: link.id, placement });
    },
    onDrop: (e: React.DragEvent<HTMLTableRowElement>) => {
      if (!drag || !acceptsDrop(link)) return;
      e.preventDefault();
      const placement = placementFor(e);
      endDrag();
      saveOrder(
        drag.kind === 'link'
          ? dropLink(links, drag.id, link, placement)
          : (moveQuickLinkCategory(links, drag.category, link.category ?? null, placement)?.ids ?? null),
      );
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
      const direction = moveDirection(e);
      if (!direction || !canReorder) return;
      e.preventDefault();
      saveOrder(moveWithinCategory(links, link.id, direction));
    },
  });

  const categoryDragHandlers = (link: ProjectQuickLink) => {
    const category = link.category ?? null;
    return {
      draggable: canReorder,
      onDragStart: (e: React.DragEvent<HTMLSpanElement>) =>
        startDrag(e, { kind: 'category', category }, category ?? OTHER_CATEGORY_LABEL),
      onDragEnd: endDrag,
      onKeyDown: (e: React.KeyboardEvent<HTMLSpanElement>) => {
        const direction = moveDirection(e);
        if (!direction || !canReorder) return;
        e.preventDefault();
        e.stopPropagation();
        saveOrder(moveCategory(links, category, direction));
      },
    };
  };

  const rowClass = (link: ProjectQuickLink): string => {
    const classes = [canReorder ? styles.rowDraggable : ''];
    if (drag?.kind === 'link' && drag.id === link.id) classes.push(styles.dragging);
    if (drag?.kind === 'category' && drag.category === (link.category ?? null)) classes.push(styles.dragging);
    if (dropHint?.rowId === link.id) classes.push(dropHint.placement === 'before' ? styles.dropBefore : styles.dropAfter);
    return classes.filter(Boolean).join(' ');
  };

  const handleConfirmDelete = () => {
    if (!deleting) return;
    setActionError(null);
    deleteLink.mutate(
      { id: deleting.id },
      {
        onSuccess: () => setDeleting(null),
        onError: (err) => {
          setDeleting(null);
          setActionError(err.message);
        },
      },
    );
  };

  const emptyMessage = links.length === 0
    ? 'No shared links yet. Links you add under “My links” in the header are private to you and don’t appear here.'
    : 'No shared links match your search or filter.';

  return (
    <section
      ref={sectionRef}
      id={QUICK_LINKS_SECTION_ID}
      className={`${gridStyles.section} ${styles.section}`}
      {...{ 'data-testid': 'quick-links-settings' }}
    >
      <div className={gridStyles.header}>
        <div>
          <h2 className={gridStyles.title}>Quick Links</h2>
          <p className={gridStyles.hint}>
            Shared links that everyone in <strong>{project}</strong> sees under &ldquo;Project links&rdquo; in
            the header link menu. Personal links are private to each person and are managed from that menu.
          </p>
        </div>
        <div className={gridStyles.headerActions}>
          <button
            type="button"
            className={gridStyles.buttonPrimary}
            onClick={() => setEditing('new')}
            {...{ 'data-testid': 'quick-links-add' }}
          >
            Add link
          </button>
        </div>
      </div>

      <DataGridToolbar
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search by label, URL, or category…"
        searchTestId="quick-links-search"
      >
        {categoryOptions.length > 0 && (
          // Categories are free text set per project, so a dropdown scales better than pills.
          <DataGridFilterSelect
            label="Category"
            value={categoryFilter}
            onChange={setCategoryFilter}
            options={categoryOptions}
            includeEmptyOption
            emptyOptionLabel="All"
            data-testid="quick-links-filter-category"
          />
        )}
      </DataGridToolbar>

      {actionError && (
        <p className={gridStyles.error} role="alert" {...{ 'data-testid': 'quick-links-action-error' }}>
          {actionError}
        </p>
      )}

      {linksQuery.isLoading && (
        <p className={gridStyles.loading} {...{ 'data-testid': 'quick-links-loading' }}>
          Loading quick links…
        </p>
      )}

      {linksQuery.isError && (
        <p className={gridStyles.error} role="alert" {...{ 'data-testid': 'quick-links-error' }}>
          {linksQuery.error instanceof Error ? linksQuery.error.message : 'Failed to load quick links'}
        </p>
      )}

      {!linksQuery.isLoading && !linksQuery.isError && filteredLinks.length === 0 && (
        <p className={gridStyles.empty} {...{ 'data-testid': 'quick-links-empty' }}>
          {emptyMessage}
        </p>
      )}

      {!linksQuery.isLoading && !linksQuery.isError && filteredLinks.length > 0 && (
        <div className={gridStyles.tableWrap} {...{ 'data-testid': 'quick-links-grid' }}>
          <table className={gridStyles.table}>
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Label</th>
                <th scope="col">URL</th>
                <th scope="col">Order</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredLinks.map((link) => (
                <tr
                  key={link.id}
                  className={rowClass(link)}
                  tabIndex={canReorder ? 0 : undefined}
                  title={canReorder ? 'Drag to reorder within its category, or press Alt+↑/↓' : undefined}
                  {...rowDragHandlers(link)}
                  {...{ 'data-testid': `quick-link-row-${link.id}` }}
                >
                  <td>
                    <span
                      className={canReorder ? styles.categoryDraggable : undefined}
                      role={canReorder ? 'button' : undefined}
                      tabIndex={canReorder ? 0 : undefined}
                      title={canReorder ? 'Drag to move this category, or press Alt+↑/↓' : undefined}
                      aria-label={canReorder ? `Category ${link.category ?? OTHER_CATEGORY_LABEL}, drag to move` : undefined}
                      {...categoryDragHandlers(link)}
                      {...{ 'data-testid': `quick-link-category-handle-${link.id}` }}
                    >
                      <CategoryPill category={link.category} data-testid={`quick-link-category-${link.id}`} />
                    </span>
                  </td>
                  <td>{link.label}</td>
                  <td className={styles.urlCell} title={link.url}>{link.url}</td>
                  <td>{link.sortOrder}</td>
                  <td>
                    <div className={gridStyles.rowActions} {...{ 'data-testid': `quick-link-row-actions-${link.id}` }}>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        onClick={() => setEditing(link)}
                        {...{ 'data-testid': `quick-link-edit-${link.id}` }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        onClick={() => setDeleting(link)}
                        {...{ 'data-testid': `quick-link-delete-${link.id}` }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <QuickLinkFormModal
          link={editing === 'new' ? null : editing}
          newSortOrder={newSortOrder}
          categories={categories}
          isPending={isSaving}
          serverError={saveError}
          onSubmit={handleSubmit}
          onCancel={closeForm}
          data-testid="quick-link-form-modal"
        />
      )}

      {deleting && (
        <ConfirmDeleteModal
          title="Delete quick link"
          itemName={deleting.label}
          isPending={deleteLink.isPending}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleting(null)}
          data-testid="quick-link-delete-modal"
        />
      )}
    </section>
  );
};

interface ProjectQuickLinksSettingsProps {
  project: string;
}

export const ProjectQuickLinksSettings: React.FC<ProjectQuickLinksSettingsProps> = ({ project }) => {
  const { can } = useAppShell();
  if (!project || !can('quick-links:manage')) return null;
  return <ProjectQuickLinksSettingsBody project={project} />;
};

export default ProjectQuickLinksSettings;
