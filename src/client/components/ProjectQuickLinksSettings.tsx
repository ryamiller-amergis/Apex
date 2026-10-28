import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
  type ProjectQuickLink,
} from '../../shared/types/projectQuickLinks';
import {
  useCreateProjectQuickLink,
  useDeleteProjectQuickLink,
  useProjectQuickLinks,
  useReorderProjectQuickLinks,
  useUpdateProjectQuickLink,
} from '../hooks/useProjectQuickLinks';
import { useAppShell } from '../hooks/useAppShell';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { DataGridFilterSelect, DataGridToolbar } from './DataGridToolbar';
import { NumberStepper } from './NumberStepper';
import gridStyles from './DataGrid.module.css';
import styles from './ProjectQuickLinksSettings.module.css';

export const QUICK_LINKS_SECTION_ID = 'quick-links';

const UNCATEGORIZED = '__none__';

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const quickLinkSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Label is required')
    .max(QUICK_LINK_LABEL_MAX_LENGTH, `Label must be ${QUICK_LINK_LABEL_MAX_LENGTH} characters or fewer`),
  url: z
    .string()
    .trim()
    .min(1, 'URL is required')
    .max(QUICK_LINK_URL_MAX_LENGTH, `URL must be ${QUICK_LINK_URL_MAX_LENGTH} characters or fewer`)
    .refine(isHttpUrl, 'Enter a full URL starting with http:// or https://'),
  category: z
    .string()
    .trim()
    .max(QUICK_LINK_CATEGORY_MAX_LENGTH, `Category must be ${QUICK_LINK_CATEGORY_MAX_LENGTH} characters or fewer`),
  sortOrder: z.number().int().min(0),
});

type QuickLinkFormValues = z.infer<typeof quickLinkSchema>;

interface QuickLinkFormModalProps {
  link: ProjectQuickLink | null;
  categories: string[];
  isPending: boolean;
  serverError: string | null;
  onSubmit: (values: QuickLinkFormValues) => void;
  onCancel: () => void;
  'data-testid'?: string;
}

const QuickLinkFormModal: React.FC<QuickLinkFormModalProps> = ({
  link,
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
      sortOrder: link?.sortOrder ?? 0,
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
          <div className={styles.field}>
            <label className={styles.label} htmlFor="quick-link-category">Category (optional)</label>
            <input
              id="quick-link-category"
              className={styles.input}
              list="quick-link-category-options"
              placeholder="e.g. Environments, Tools"
              aria-invalid={Boolean(errors.category)}
              {...register('category')}
              {...{ 'data-testid': 'quick-link-form-category' }}
            />
            <datalist id="quick-link-category-options">
              {categories.map((c) => <option key={c} value={c} />)}
            </datalist>
            {errors.category && <p className={styles.fieldError}>{errors.category.message}</p>}
          </div>

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

  const links = useMemo(() => linksQuery.data ?? [], [linksQuery.data]);

  const categories = useMemo(
    () => Array.from(new Set(links.map((l) => l.category).filter((c): c is string => Boolean(c)))),
    [links],
  );

  const categoryOptions = useMemo(
    () => [
      ...categories.map((c) => ({ label: c, value: c })),
      ...(links.some((l) => !l.category) ? [{ label: 'Uncategorized', value: UNCATEGORIZED }] : []),
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

  const handleMove = (id: string, direction: -1 | 1) => {
    const ids = moveWithinCategory(links, id, direction);
    if (!ids) return;
    setActionError(null);
    reorderLinks.mutate({ ids }, { onError: (err) => setActionError(err.message) });
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

  const hasFilter = Boolean(search.trim() || categoryFilter);
  const emptyMessage = links.length === 0
    ? 'No quick links yet. Add links to environments and tools your team uses for this project.'
    : 'No quick links match your search or filter.';

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
            Links shown in the header link menu for <strong>{project}</strong> only.
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
                <tr key={link.id} {...{ 'data-testid': `quick-link-row-${link.id}` }}>
                  <td>{link.category ?? <span className={styles.muted}>Uncategorized</span>}</td>
                  <td>{link.label}</td>
                  <td className={styles.urlCell} title={link.url}>{link.url}</td>
                  <td>{link.sortOrder}</td>
                  <td>
                    <div className={gridStyles.rowActions} {...{ 'data-testid': `quick-link-row-actions-${link.id}` }}>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        onClick={() => handleMove(link.id, -1)}
                        disabled={hasFilter || reorderLinks.isPending || !moveWithinCategory(links, link.id, -1)}
                        aria-label={`Move ${link.label} up`}
                        {...{ 'data-testid': `quick-link-move-up-${link.id}` }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={gridStyles.buttonGhost}
                        onClick={() => handleMove(link.id, 1)}
                        disabled={hasFilter || reorderLinks.isPending || !moveWithinCategory(links, link.id, 1)}
                        aria-label={`Move ${link.label} down`}
                        {...{ 'data-testid': `quick-link-move-down-${link.id}` }}
                      >
                        ↓
                      </button>
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
